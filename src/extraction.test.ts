import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { getPDFReader } from './index';
import type { PDFReader } from './shared/types';

describe('PDF Content Extraction', () => {
  let reader: PDFReader;
  let pdfPath: string;

  beforeEach(async () => {
    reader = await getPDFReader();
    pdfPath = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'test',
      'Signed-Meeting-Minutes-October-8-2024-Regular-Council-Meeting-1.pdf',
    );
  });

  it('should extract metadata from PDF', async () => {
    const metadata = await reader.extractMetadata(pdfPath);

    expect(metadata).toBeDefined();
    expect(metadata.pageCount).toBe(3);
  });

  it('should analyze PDF and detect it requires OCR', async () => {
    const info = await reader.getInfo(pdfPath);

    expect(info.pageCount).toBe(3);
    expect(info.hasEmbeddedText).toBe(false);
    expect(info.ocrRequired).toBe(true);
    expect(info.recommendedStrategy).toBe('ocr');
  });

  it('should extract images from scanned PDF', async () => {
    const images = await reader.extractImages(pdfPath);

    // Scanned PDF should have embedded images (one per page)
    expect(images.length).toBe(3);

    // Each image should have valid data
    for (const image of images) {
      expect(image.data).toBeDefined();
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
    }
  });

  it('should extract text from scanned PDF via OCR fallback', async () => {
    const text = await reader.extractText(pdfPath);

    // Must successfully extract text, not return null
    expect(text).not.toBeNull();
    expect(typeof text).toBe('string');

    // Must extract meaningful content from 3-page document
    expect(text!.length).toBeGreaterThan(100);

    // Should contain "Bentley" (the town name in the document)
    expect(text!.toLowerCase()).toContain('bentley');
  }, 60000);
});
