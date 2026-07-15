/**
 * Public entry point for Node.js PDF processing and generation utilities.
 *
 * The stable package surface is Node-first. It exposes extraction, OCR,
 * image-encoding, Markdown-to-PDF, and HTML-to-PDF helpers from one ESM entry.
 */

// Re-export base provider for custom implementations
export { BasePDFReader } from './shared/base';
// Export main factory function and types
export {
  getAvailableProviders,
  getPDFReader,
  getProviderInfo,
  initializeProviders,
  isProviderAvailable,
} from './shared/factory';
// Pure helper, safe in any environment. Use this when you only need to
// normalize a `format` string to a canonical IANA mime type.
export { canonicalizeImageFormat } from './shared/image-format';
export * from './shared/types';

import type {
  ImageEncodingOptions,
  PDFImage,
  PDFImageOutputFormat,
} from './shared/types';

/**
 * Re-encode an already-extracted `PDFImage` to a web-safe format.
 *
 * Companion to `extractImages({ outputFormat })`. Use this when the original
 * extraction returned `outputFormat: 'original'` and the caller now wants a
 * web-safe asset.
 *
 * Node-only at runtime: the encoder is loaded lazily so that importing
 * `@happyvertical/pdf` from a browser context does not pull in
 * `@napi-rs/canvas` until you actually call this function.
 */
export async function encodePDFImage(
  image: PDFImage,
  target: PDFImageOutputFormat = 'webp',
  options?: ImageEncodingOptions,
): Promise<PDFImage> {
  const mod = await import('./node/image-encoding');
  return mod.encodePDFImage(image, target, options);
}

// Markdown-to-PDF generation (pure JS, no headless browser).
export {
  flattenInlineTokens,
  type MarkdownInlineToken,
  PDFGenerationError,
  type RenderMarkdownToPdfOptions,
  renderMarkdownToPdf,
  type StyledRun,
} from './generation/markdown-pdf';
export type {
  HtmlToPdfFormat,
  HtmlToPdfMargin,
  HtmlToPdfOptions,
} from './node/html-to-pdf';

/**
 * Render an HTML document to PDF bytes using a system Chromium.
 *
 * Generation counterpart to the extraction providers. Uses `puppeteer-core`
 * without downloading a browser, so callers must provide a Chromium binary in
 * the image, through `PUPPETEER_EXECUTABLE_PATH`, or through
 * `options.executablePath`.
 *
 * Node-only at runtime: the browser engine is loaded lazily so that importing
 * `@happyvertical/pdf` never pulls browser automation code until you actually
 * render.
 */
export async function renderHtmlToPdf(
  html: string,
  options?: import('./node/html-to-pdf').HtmlToPdfOptions,
): Promise<Uint8Array> {
  const mod = await import('./node/html-to-pdf');
  return mod.renderHtmlToPdf(html, options);
}

/**
 * Locate a usable Chromium/Chrome binary (`PUPPETEER_EXECUTABLE_PATH` first,
 * then well-known install locations). Returns `undefined` when none is found.
 */
export async function resolveChromiumExecutablePath(): Promise<
  string | undefined
> {
  const mod = await import('./node/html-to-pdf');
  return mod.resolveChromiumExecutablePath();
}

// Legacy compatibility exports for backward compatibility with existing code
import { getPDFReader, initializeProviders } from './shared/factory';

/**
 * Extract text from a PDF file (legacy compatibility)
 * @deprecated Use getPDFReader().extractText() instead
 */
export async function extractTextFromPDF(
  pdfPath: string,
): Promise<string | null> {
  const reader = await getPDFReader();
  return reader.extractText(pdfPath);
}

/**
 * Extract images from all pages of a PDF file (legacy compatibility)
 *
 * Requires the unpdf provider; kreuzberg integrates OCR into extractText().
 *
 * @deprecated Use getPDFReader().extractImages() instead
 */
export async function extractImagesFromPDF(
  pdfPath: string,
  options?: { provider?: 'unpdf' | 'kreuzberg' | 'auto' },
): Promise<PDFImage[] | null> {
  const reader = await getPDFReader({ provider: options?.provider ?? 'unpdf' });
  const images = await reader.extractImages(pdfPath);
  return images.length > 0 ? images : null;
}

/**
 * Perform OCR on image data (legacy compatibility)
 *
 * Requires the unpdf provider; kreuzberg integrates OCR into extractText().
 *
 * @deprecated Use getPDFReader().performOCR() instead
 */
export async function performOCROnImages(
  images: PDFImage[],
  options?: { provider?: 'unpdf' | 'kreuzberg' | 'auto' },
): Promise<string> {
  const reader = await getPDFReader({ provider: options?.provider ?? 'unpdf' });
  const result = await reader.performOCR(images);
  return result.text;
}

/**
 * Check if OCR dependencies are available (legacy compatibility)
 * @deprecated Use getPDFReader().checkDependencies() instead
 */
export async function checkOCRDependencies() {
  const reader = await getPDFReader();
  return reader.checkDependencies();
}

// Initialize providers on module load.
void initializeProviders().catch(() => {
  // Ignore initialization errors - providers will fail when used
});

// Default export for convenience
import * as factory from './shared/factory';
export default factory;

/** @internal */
export const PACKAGE_VERSION_INITIALIZED = true;
