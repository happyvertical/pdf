import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  flattenInlineTokens,
  PDFGenerationError,
  renderMarkdownToPdf,
} from '../index';

/** %PDF- magic bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

const MULTI_SECTION = `# Project Plan

A short introductory **paragraph** describing the *plan* and its goals with
enough text to wrap across more than one line of the content area.

## Milestones

### Phase One

Some details about phase one go here.

- First bullet point
- Second bullet point with **bold** text
- Third bullet point

1. Initial step
2. Follow-up step
3. Final step

---

\`\`\`ts
const answer = 42;
console.log(answer);
\`\`\`

> A blockquote summarizing the plan.
`;

describe('renderMarkdownToPdf', () => {
  it('renders a multi-section document to a parseable PDF', async () => {
    const bytes = await renderMarkdownToPdf(MULTI_SECTION, {
      title: 'Q3 Plan',
    });

    expect(bytes).toBeInstanceOf(Uint8Array);
    // Magic bytes.
    expect(Array.from(bytes.subarray(0, 5))).toEqual(PDF_MAGIC);
    // Non-trivially sized.
    expect(bytes.length).toBeGreaterThan(1500);

    // Loads back with pdf-lib and the title round-trips through metadata.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe('Q3 Plan');
  });

  it('paginates a long document onto multiple pages', async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 120; i++) {
      paragraphs.push(
        `## Section ${i}\n\nParagraph ${i} with several words to fill vertical space and force the layout cursor to overflow onto additional pages.`,
      );
    }
    const bytes = await renderMarkdownToPdf(paragraphs.join('\n\n'));

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('does not crash on empty or whitespace-only markdown', async () => {
    const empty = await renderMarkdownToPdf('');
    expect(Array.from(empty.subarray(0, 5))).toEqual(PDF_MAGIC);
    expect((await PDFDocument.load(empty)).getPageCount()).toBe(1);

    const blank = await renderMarkdownToPdf('   \n\n\t  \n');
    expect(Array.from(blank.subarray(0, 5))).toEqual(PDF_MAGIC);
    expect((await PDFDocument.load(blank)).getPageCount()).toBe(1);
  });

  it('honors page size and margin options', async () => {
    const a4 = await renderMarkdownToPdf('# A4\n\nbody', {
      pageSize: 'a4',
      margin: 36,
    });
    const doc = await PDFDocument.load(a4);
    const [page] = doc.getPages();
    // A4 height in points (~841.89).
    expect(page.getHeight()).toBeGreaterThan(800);
    expect(page.getHeight()).toBeLessThan(900);
  });

  it('hard-breaks a pathologically long unbroken token', async () => {
    const huge = `x${'a'.repeat(5000)}x`;
    const bytes = await renderMarkdownToPdf(huge, { pageSize: 'letter' });
    // Should produce a valid PDF without throwing or writing off-page.
    expect(Array.from(bytes.subarray(0, 5))).toEqual(PDF_MAGIC);
    expect(
      (await PDFDocument.load(bytes)).getPageCount(),
    ).toBeGreaterThanOrEqual(1);
  });

  it('throws a typed error for non-string input', async () => {
    await expect(
      // @ts-expect-error intentionally wrong type
      renderMarkdownToPdf(undefined),
    ).rejects.toBeInstanceOf(PDFGenerationError);
  });
});

describe('flattenInlineTokens', () => {
  it('strips bold/italic markers and styles the runs', () => {
    // Shape mirrors marked's inline tokens; markers live only in `.raw`.
    const runs = flattenInlineTokens([
      { type: 'text', text: 'Plain ' },
      { type: 'strong', tokens: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', tokens: [{ type: 'text', text: 'italic' }] },
    ]);

    const joined = runs.map((r) => r.text).join('');
    expect(joined).toContain('bold');
    expect(joined).toContain('italic');
    // No literal markdown markers leaked into any run.
    expect(joined).not.toContain('**');
    expect(joined).not.toContain('*');
    expect(joined).not.toContain('_');

    const boldRun = runs.find((r) => r.text === 'bold');
    const italicRun = runs.find((r) => r.text === 'italic');
    expect(boldRun?.bold).toBe(true);
    expect(boldRun?.italic).toBe(false);
    expect(italicRun?.italic).toBe(true);
    expect(italicRun?.bold).toBe(false);
  });

  it('marks codespans as monospace and carries nested styling', () => {
    const runs = flattenInlineTokens([
      { type: 'codespan', text: 'const x = 1' },
      {
        type: 'strong',
        tokens: [
          { type: 'em', tokens: [{ type: 'text', text: 'bolditalic' }] },
        ],
      },
    ]);

    const codeRun = runs.find((r) => r.code);
    expect(codeRun?.text).toBe('const x = 1');

    const nested = runs.find((r) => r.text === 'bolditalic');
    expect(nested?.bold).toBe(true);
    expect(nested?.italic).toBe(true);
  });

  it('returns no runs for undefined or empty input', () => {
    expect(flattenInlineTokens(undefined)).toEqual([]);
    expect(flattenInlineTokens([])).toEqual([]);
  });
});
