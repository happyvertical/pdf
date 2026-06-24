import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { getPDFReader } from './index';
import type { PDFReader } from './shared/types';

const OCR_TEST_TIMEOUT_MS = process.env.CI === 'true' ? 240000 : 120000;

describe('PDF Content Extraction', () => {
  let reader: PDFReader;
  let unpdfReader: PDFReader;
  let pdfPath: string;

  beforeEach(async () => {
    reader = await getPDFReader();
    unpdfReader = await getPDFReader({ provider: 'unpdf' });
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

  it('should analyze PDF and detect it requires OCR (unpdf)', async () => {
    // Use unpdf for detailed analysis - kreuzberg handles OCR internally
    // and doesn't expose these details the same way
    const info = await unpdfReader.getInfo(pdfPath);

    expect(info.pageCount).toBe(3);
    expect(info.hasEmbeddedText).toBe(false);
    expect(info.ocrRequired).toBe(true);
    expect(info.recommendedStrategy).toBe('ocr');
  });

  it('should extract images from scanned PDF (unpdf)', async () => {
    // Use unpdf for image extraction - kreuzberg integrates OCR into extractText()
    const images = await unpdfReader.extractImages(pdfPath);

    // Scanned PDF should have embedded images (one per page)
    expect(images.length).toBe(3);

    // Each image should have valid data
    for (const image of images) {
      expect(image.data).toBeDefined();
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
    }
  });

  it('should default extractImages to web-safe webp output (issue #73)', async () => {
    // Default behavior: re-encode raw RGB streams to webp so callers can
    // store / serve `image.data` directly.
    const images = await unpdfReader.extractImages(pdfPath);

    expect(images.length).toBe(3);
    for (const image of images) {
      expect(image.format).toBe('image/webp');
      // WebP signature: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
      const buf = image.data as Buffer;
      const header = buf.subarray(0, 4).toString('ascii');
      const signature = buf.subarray(8, 12).toString('ascii');
      expect(header).toBe('RIFF');
      expect(signature).toBe('WEBP');
      // Encoded outputs intentionally drop bitsPerComponent.
      expect(image.bitsPerComponent).toBeUndefined();
    }
  });

  it('should expose canonical mime types and bitsPerComponent on raw output (issues #73 + #74 + ocr#75)', async () => {
    const images = await unpdfReader.extractImages(pdfPath, {
      outputFormat: 'original',
    });

    expect(images.length).toBe(3);
    for (const image of images) {
      // Canonical IANA mime types only — no 'rgb', 'unknown', etc.
      expect(image.format).toMatch(
        /^(image\/x-rgb|image\/x-rgba|image\/x-grayscale|image\/x-cmyk|image\/jpeg|image\/png|application\/octet-stream)$/,
      );
      // Raw 8-bit pixel buffers carry bitsPerComponent so consumers can
      // decode the buffer without guessing (ocr#75).
      if (image.format?.startsWith('image/x-')) {
        expect(image.bitsPerComponent).toBe(8);
      }
    }
  });

  it('should re-encode extractImages output to png on demand', async () => {
    const images = await unpdfReader.extractImages(pdfPath, {
      outputFormat: 'png',
    });

    expect(images.length).toBe(3);
    for (const image of images) {
      expect(image.format).toBe('image/png');
      // PNG signature
      const buf = image.data as Buffer;
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    }
  });

  it('should keep image extraction working with the auto reader', async () => {
    const images = await reader.extractImages(pdfPath);

    expect(images.length).toBe(3);
    for (const image of images) {
      expect(image.data).toBeDefined();
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
    }
  });

  it(
    'should extract text from scanned PDF via OCR fallback',
    async () => {
      const text = await reader.extractText(pdfPath);

      // Must successfully extract text, not return null
      expect(text).not.toBeNull();
      expect(typeof text).toBe('string');

      // Must extract meaningful content from 3-page document
      expect(text?.length).toBeGreaterThan(100);

      // Should contain "Bentley" (the town name in the document)
      expect(text?.toLowerCase()).toContain('bentley');
    },
    OCR_TEST_TIMEOUT_MS,
  );
});
