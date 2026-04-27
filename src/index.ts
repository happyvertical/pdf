/**
 * @happyvertical/pdf - Shared entry point with automatic environment detection
 *
 * This entry point automatically detects the runtime environment and provides
 * the appropriate PDF processing capabilities for both Node.js and browser environments.
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
export * from './shared/types';

// Pure helper — safe in any environment. Use this when you only need to
// normalize a `format` string to a canonical IANA mime type per issue #74.
export { canonicalizeImageFormat } from './shared/image-format';

import type {
  ImageEncodingOptions,
  PDFImage,
  PDFImageOutputFormat,
} from './shared/types';

/**
 * Re-encode an already-extracted `PDFImage` to a web-safe format.
 *
 * Companion to `extractImages({ outputFormat })` (issue #73). Use this when
 * the original extraction returned `outputFormat: 'original'` and the
 * caller now wants a web-safe asset.
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
 * @deprecated Use getPDFReader().extractImages() instead
 * @note Requires unpdf provider - kreuzberg integrates OCR into extractText()
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
 * @deprecated Use getPDFReader().performOCR() instead
 * @note Requires unpdf provider - kreuzberg integrates OCR into extractText()
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
