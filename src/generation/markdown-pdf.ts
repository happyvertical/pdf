/**
 * @happyvertical/pdf - Markdown to PDF generation.
 *
 * Generation counterpart to the extraction providers, but unlike
 * `renderHtmlToPdf` (which needs a real browser engine for faithful CSS) this
 * renderer is **footprint-safe**: it constructs the document with `pdf-lib`
 * (pure JS, no native deps) and tokenizes markdown with `marked`. There is no
 * headless browser, no font download, and nothing native — so it runs in any
 * Node server (and is isomorphic enough for the shared entry point).
 *
 * The quality bar is a clean, readable client-facing document, not
 * pixel-perfect typography. Supported blocks: ATX headings (`#`/`##`/`###`+),
 * paragraphs (word-wrapped), unordered and ordered lists, horizontal rules,
 * fenced/indented code blocks, and blockquotes. Inline emphasis
 * (`**bold**` / `*italic*` / `` `code` ``) is rendered with the matching
 * Standard font; markers never leak into the output.
 *
 * Layout is a single-pass top-to-bottom flow with a tracked y cursor; when the
 * next line would cross the bottom margin a new page is started, so content is
 * never written off-page.
 */

import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import { PDFError } from '../shared/types';

/**
 * Thrown when a markdown document cannot be rendered to a PDF.
 *
 * Matches the typed-error style of the extraction side (`PDFError` subclasses
 * with a stable `code` and `name`). Today the only fatal case is markdown that
 * tokenizes to nothing renderable; pathological-but-renderable input (huge
 * unbroken tokens, empty paragraphs) is handled gracefully instead of thrown.
 */
export class PDFGenerationError extends PDFError {
  constructor(message: string) {
    super(message, 'EGENERATION');
    this.name = 'PDFGenerationError';
  }
}

/**
 * Options for {@link renderMarkdownToPdf}.
 */
export interface RenderMarkdownToPdfOptions {
  /** Optional document title rendered at the top + set as PDF metadata title. */
  title?: string;
  /** Page size, default "letter". */
  pageSize?: 'letter' | 'a4';
  /** Margin in points, default 54 (0.75in). */
  margin?: number;
}

/** Page dimensions in points (1pt = 1/72in). */
const PAGE_SIZES: Record<'letter' | 'a4', readonly [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
};

const DEFAULT_MARGIN = 54;

/** Font size and following gap (points) for each heading depth (1-based). */
const HEADING_STYLES: Record<number, { size: number; gap: number }> = {
  1: { size: 24, gap: 12 },
  2: { size: 18, gap: 10 },
  3: { size: 15, gap: 8 },
  4: { size: 13, gap: 6 },
  5: { size: 12, gap: 6 },
  6: { size: 11, gap: 6 },
};

const BODY_SIZE = 11;
const CODE_SIZE: number = 10;
const LINE_GAP = 1.35; // line-height multiplier
const PARAGRAPH_GAP = 8;
const LIST_INDENT = 18;
const BLOCKQUOTE_INDENT = 18;
const CODE_PADDING = 6;

/**
 * A run of text with a single style. Inline markdown is flattened into a list
 * of these so the layout engine can word-wrap across style boundaries.
 */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Monospace (inline code span). */
  code: boolean;
}

/**
 * A minimal subset of a `marked` inline token. Declared locally so this module
 * does not depend on marked's exported token unions (which churn across
 * versions) — we only read the fields we render.
 */
interface InlineToken {
  type: string;
  text?: string;
  tokens?: InlineToken[];
}

/**
 * Flatten marked inline tokens into styled runs, carrying bold/italic context
 * down through nesting. `strong`/`em` toggle styling; `codespan` becomes a
 * monospace run; everything textual contributes its text. Markdown markers
 * (`**`, `*`, `_`, `` ` ``) never survive because we read token `.text`, not
 * `.raw`.
 *
 * Exported and pure so it can be unit-tested directly without rendering a PDF.
 */
export function flattenInlineTokens(
  tokens: InlineToken[] | undefined,
  inherited: { bold?: boolean; italic?: boolean } = {},
): StyledRun[] {
  const runs: StyledRun[] = [];
  if (!tokens) return runs;

  for (const token of tokens) {
    const bold = inherited.bold ?? false;
    const italic = inherited.italic ?? false;

    switch (token.type) {
      case 'strong':
        runs.push(...flattenInlineTokens(token.tokens, { bold: true, italic }));
        break;
      case 'em':
        runs.push(...flattenInlineTokens(token.tokens, { bold, italic: true }));
        break;
      case 'del':
        // No strikethrough Standard font; render text without the markers.
        runs.push(...flattenInlineTokens(token.tokens, { bold, italic }));
        break;
      case 'codespan':
        if (token.text) {
          runs.push({ text: token.text, bold, italic, code: true });
        }
        break;
      case 'link':
      case 'text':
        // A `text` token may itself contain nested inline tokens (links,
        // emphasis inside list items). Recurse when present; otherwise it is a
        // leaf whose `.text` is the literal string (markers already stripped).
        if (token.tokens && token.tokens.length > 0) {
          runs.push(...flattenInlineTokens(token.tokens, { bold, italic }));
        } else if (token.text) {
          runs.push({ text: token.text, bold, italic, code: false });
        }
        break;
      default:
        // br, escape, html, etc. — fold any nested tokens, else take .text.
        if (token.tokens && token.tokens.length > 0) {
          runs.push(...flattenInlineTokens(token.tokens, { bold, italic }));
        } else if (token.text) {
          runs.push({ text: token.text, bold, italic, code: false });
        }
        break;
    }
  }

  // Collapse to non-empty runs; normalize whitespace within (newlines from
  // soft-wrapped source become spaces so word-wrap controls line breaks).
  return runs
    .map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
    .filter((run) => run.text.length > 0);
}

/** Fonts resolved once per document from the Standard 14. */
interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

function fontForRun(fonts: FontSet, run: StyledRun): PDFFont {
  if (run.code) return fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/**
 * Mutable layout cursor threaded through the render. Owns the current page and
 * y position and knows how to break to a new page when content would overflow.
 */
class Layout {
  page: PDFPage;
  y: number;
  readonly width: number;
  readonly height: number;
  readonly margin: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly size: readonly [number, number],
    margin: number,
  ) {
    this.width = size[0];
    this.height = size[1];
    this.margin = margin;
    this.page = doc.addPage([size[0], size[1]]);
    this.y = size[1] - margin;
  }

  /** Usable content width between the left and right margins. */
  get contentWidth(): number {
    return this.width - this.margin * 2;
  }

  /** Ensure `needed` points of vertical space remain; else start a new page. */
  ensureSpace(needed: number): void {
    if (this.y - needed < this.margin) {
      this.page = this.doc.addPage([this.size[0], this.size[1]]);
      this.y = this.height - this.margin;
    }
  }
}

/**
 * Break a single word that is wider than `maxWidth` into hard fragments that
 * each fit. Guards against pathological unbroken tokens (long URLs, hashes)
 * that would otherwise be written off the right edge.
 */
function hardBreakWord(
  word: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const fragments: string[] = [];
  let current = '';
  for (const char of word) {
    const next = current + char;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      fragments.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) fragments.push(current);
  return fragments;
}

/** A laid-out line: positioned runs sharing a baseline. */
interface LaidOutRun {
  text: string;
  font: PDFFont;
  size: number;
}
type LaidOutLine = LaidOutRun[];

/**
 * Word-wrap styled runs into lines that fit `maxWidth`. Runs keep their font;
 * wrapping happens at word boundaries, and over-long words are hard-broken.
 */
function wrapRuns(
  runs: StyledRun[],
  fonts: FontSet,
  size: number,
  maxWidth: number,
): LaidOutLine[] {
  const lines: LaidOutLine[] = [];
  let line: LaidOutLine = [];
  let lineWidth = 0;
  const spaceWidth = fonts.regular.widthOfTextAtSize(' ', size);

  const pushLine = () => {
    lines.push(line);
    line = [];
    lineWidth = 0;
  };

  for (const run of runs) {
    const font = fontForRun(fonts, run);
    const runSize = run.code ? Math.min(size, CODE_SIZE) : size;
    // Split into words; whitespace was already normalized to single spaces.
    const words = run.text.split(' ').filter((w) => w.length > 0);
    for (const rawWord of words) {
      const fragments = hardBreakWord(rawWord, font, runSize, maxWidth);
      for (let i = 0; i < fragments.length; i++) {
        const word = fragments[i];
        const wordWidth = font.widthOfTextAtSize(word, runSize);
        const needsSpace = lineWidth > 0;
        const addWidth = (needsSpace ? spaceWidth : 0) + wordWidth;
        if (lineWidth > 0 && lineWidth + addWidth > maxWidth) {
          pushLine();
        }
        const text = lineWidth > 0 ? ` ${word}` : word;
        line.push({ text, font, size: runSize });
        lineWidth += line.length === 1 ? wordWidth : addWidth;
        // A hard-broken fragment (except the last) forces a line break.
        if (fragments.length > 1 && i < fragments.length - 1) {
          pushLine();
        }
      }
    }
  }

  if (line.length > 0) pushLine();
  if (lines.length === 0) lines.push([]);
  return lines;
}

/** Draw pre-wrapped lines starting at the current cursor, paginating as needed. */
function drawLines(
  layout: Layout,
  lines: LaidOutLine[],
  size: number,
  x: number,
  color = rgb(0, 0, 0),
): void {
  const lineHeight = size * LINE_GAP;
  for (const line of lines) {
    layout.ensureSpace(lineHeight);
    layout.y -= lineHeight;
    let cursorX = x;
    for (const run of line) {
      layout.page.drawText(run.text, {
        x: cursorX,
        y: layout.y,
        size: run.size,
        font: run.font,
        color,
      });
      cursorX += run.font.widthOfTextAtSize(run.text, run.size);
    }
  }
}

function renderHeading(
  layout: Layout,
  fonts: FontSet,
  depth: number,
  tokens: InlineToken[] | undefined,
): void {
  const style = HEADING_STYLES[depth] ?? HEADING_STYLES[6];
  const runs = flattenInlineTokens(tokens).map((r) => ({ ...r, bold: true }));
  const lines = wrapRuns(runs, fonts, style.size, layout.contentWidth);
  // Keep a little breathing room above headings (except at page top).
  if (layout.y < layout.height - layout.margin) {
    layout.y -= style.gap / 2;
  }
  drawLines(layout, lines, style.size, layout.margin);
  layout.y -= style.gap;
}

function renderParagraph(
  layout: Layout,
  fonts: FontSet,
  tokens: InlineToken[] | undefined,
  indent = 0,
): void {
  const runs = flattenInlineTokens(tokens);
  if (runs.length === 0) {
    layout.y -= PARAGRAPH_GAP;
    return;
  }
  const lines = wrapRuns(runs, fonts, BODY_SIZE, layout.contentWidth - indent);
  drawLines(layout, lines, BODY_SIZE, layout.margin + indent);
  layout.y -= PARAGRAPH_GAP;
}

interface ListItemToken {
  tokens?: Array<{ type: string; tokens?: InlineToken[]; text?: string }>;
}

function renderList(
  layout: Layout,
  fonts: FontSet,
  ordered: boolean,
  start: number,
  items: ListItemToken[],
): void {
  const markerWidth = LIST_INDENT;
  let index = Number.isFinite(start) ? start : 1;

  for (const item of items) {
    const marker = ordered ? `${index}.` : '•';
    index += 1;

    // Collect inline runs from the item's child tokens (text/paragraph blocks).
    const runs: StyledRun[] = [];
    for (const child of item.tokens ?? []) {
      if (child.tokens) {
        runs.push(...flattenInlineTokens(child.tokens));
      } else if (child.text) {
        runs.push(...flattenInlineTokens([{ type: 'text', text: child.text }]));
      }
    }

    const lines = wrapRuns(
      runs,
      fonts,
      BODY_SIZE,
      layout.contentWidth - markerWidth,
    );
    const lineHeight = BODY_SIZE * LINE_GAP;

    // Draw marker on the first line, body lines indented past it.
    layout.ensureSpace(lineHeight);
    layout.y -= lineHeight;
    layout.page.drawText(marker, {
      x: layout.margin,
      y: layout.y,
      size: BODY_SIZE,
      font: fonts.regular,
    });
    let cursorX = layout.margin + markerWidth;
    for (const run of lines[0] ?? []) {
      layout.page.drawText(run.text, {
        x: cursorX,
        y: layout.y,
        size: run.size,
        font: run.font,
      });
      cursorX += run.font.widthOfTextAtSize(run.text, run.size);
    }
    // Remaining wrapped lines for this item.
    if (lines.length > 1) {
      drawLines(layout, lines.slice(1), BODY_SIZE, layout.margin + markerWidth);
    }
  }
  layout.y -= PARAGRAPH_GAP;
}

function renderCode(layout: Layout, fonts: FontSet, text: string): void {
  const rawLines = text.replace(/\n$/, '').split('\n');
  const innerWidth = layout.contentWidth - CODE_PADDING * 2;
  const lineHeight = CODE_SIZE * LINE_GAP;

  // Hard-wrap each source line to the code box width (monospace).
  const wrapped: string[] = [];
  for (const raw of rawLines) {
    if (raw.length === 0) {
      wrapped.push('');
      continue;
    }
    let remaining = raw;
    while (remaining.length > 0) {
      if (fonts.mono.widthOfTextAtSize(remaining, CODE_SIZE) <= innerWidth) {
        wrapped.push(remaining);
        break;
      }
      let cut = remaining.length;
      while (
        cut > 1 &&
        fonts.mono.widthOfTextAtSize(remaining.slice(0, cut), CODE_SIZE) >
          innerWidth
      ) {
        cut -= 1;
      }
      wrapped.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
  }

  const bg = rgb(0.95, 0.95, 0.96);
  for (const codeLine of wrapped) {
    layout.ensureSpace(lineHeight);
    layout.y -= lineHeight;
    // Light background band behind the line for readability.
    layout.page.drawRectangle({
      x: layout.margin,
      y: layout.y - lineHeight * 0.25,
      width: layout.contentWidth,
      height: lineHeight,
      color: bg,
    });
    layout.page.drawText(codeLine, {
      x: layout.margin + CODE_PADDING,
      y: layout.y,
      size: CODE_SIZE,
      font: fonts.mono,
      color: rgb(0.1, 0.1, 0.15),
    });
  }
  layout.y -= PARAGRAPH_GAP;
}

function renderHorizontalRule(layout: Layout): void {
  layout.ensureSpace(PARAGRAPH_GAP * 2);
  layout.y -= PARAGRAPH_GAP;
  layout.page.drawLine({
    start: { x: layout.margin, y: layout.y },
    end: { x: layout.width - layout.margin, y: layout.y },
    thickness: 0.75,
    color: rgb(0.7, 0.7, 0.7),
  });
  layout.y -= PARAGRAPH_GAP;
}

interface BlockToken {
  type: string;
  depth?: number;
  text?: string;
  ordered?: boolean;
  start?: number | string;
  items?: ListItemToken[];
  tokens?: InlineToken[];
}

function renderBlockquote(
  layout: Layout,
  fonts: FontSet,
  tokens: BlockToken[] | undefined,
): void {
  const startY = layout.y;
  // Render the contained blocks indented; draw a left bar afterward.
  for (const child of tokens ?? []) {
    if (child.type === 'paragraph') {
      renderParagraph(layout, fonts, child.tokens, BLOCKQUOTE_INDENT);
    } else if (child.type === 'text') {
      renderParagraph(
        layout,
        fonts,
        child.tokens ?? [{ type: 'text', text: child.text }],
        BLOCKQUOTE_INDENT,
      );
    }
  }
  // Quote bar on the page where the quote started (best-effort, single page).
  layout.page.drawRectangle({
    x: layout.margin + 4,
    y: layout.y,
    width: 2.5,
    height: Math.max(0, startY - layout.y),
    color: rgb(0.75, 0.75, 0.78),
  });
}

/**
 * Render a markdown string to a PDF document, returned as bytes.
 *
 * Pure-JS and footprint-safe: builds the PDF with `pdf-lib` and tokenizes with
 * `marked`. No headless browser, no native modules, no font embedding (uses the
 * Standard 14 Helvetica/Courier families). Safe to call on a Node server.
 *
 * @example
 * ```typescript
 * import { renderMarkdownToPdf } from '@happyvertical/pdf';
 *
 * const pdf = await renderMarkdownToPdf('# Plan\n\nDo the thing.', {
 *   title: 'Project Plan',
 *   pageSize: 'letter',
 * });
 * await writeFile('plan.pdf', pdf);
 * ```
 *
 * @param markdown - Markdown source. Empty/whitespace-only input renders a
 *   valid minimal one-page PDF (with the title, if provided) rather than
 *   throwing.
 * @param options - {@link RenderMarkdownToPdfOptions}.
 * @returns PDF document bytes.
 * @throws {PDFGenerationError} When `markdown` is not a string.
 */
export async function renderMarkdownToPdf(
  markdown: string,
  options: RenderMarkdownToPdfOptions = {},
): Promise<Uint8Array> {
  if (typeof markdown !== 'string') {
    throw new PDFGenerationError(
      `renderMarkdownToPdf: expected a markdown string, received ${typeof markdown}.`,
    );
  }

  const pageSize = options.pageSize ?? 'letter';
  const size = PAGE_SIZES[pageSize] ?? PAGE_SIZES.letter;
  const margin =
    typeof options.margin === 'number' && options.margin >= 0
      ? options.margin
      : DEFAULT_MARGIN;

  const { lexer } = await import('marked');
  const doc = await PDFDocument.create();
  doc.setProducer('@happyvertical/pdf');
  doc.setCreator('@happyvertical/pdf renderMarkdownToPdf');
  if (options.title) doc.setTitle(options.title);

  const fonts: FontSet = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };

  const layout = new Layout(doc, size, margin);

  // Optional title as a large bold heading at the top of the first page.
  if (options.title) {
    renderHeading(layout, fonts, 1, [{ type: 'text', text: options.title }]);
    layout.y -= 4;
  }

  const tokens = lexer(markdown) as BlockToken[];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        renderHeading(layout, fonts, token.depth ?? 1, token.tokens);
        break;
      case 'paragraph':
        renderParagraph(layout, fonts, token.tokens);
        break;
      case 'list':
        renderList(
          layout,
          fonts,
          token.ordered ?? false,
          typeof token.start === 'number' ? token.start : 1,
          token.items ?? [],
        );
        break;
      case 'code':
        renderCode(layout, fonts, token.text ?? '');
        break;
      case 'hr':
        renderHorizontalRule(layout);
        break;
      case 'blockquote':
        renderBlockquote(layout, fonts, token.tokens as BlockToken[]);
        break;
      case 'space':
        break;
      default:
        // Unknown block: render its raw text as a paragraph if any.
        if (token.text) {
          renderParagraph(layout, fonts, [{ type: 'text', text: token.text }]);
        }
        break;
    }
  }

  return doc.save();
}
