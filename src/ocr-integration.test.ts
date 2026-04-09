import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOCRDependencies, getPDFReader } from './index';
import type { PDFReader } from './shared/types';

describe.skipIf(process.env.CI === 'true')(
  'OCR Integration with Real PDF',
  () => {
    let reader: PDFReader;
    let onnxReader: PDFReader;
    let unpdfReader: PDFReader;
    let ocrAvailable = false;
    const originalTessdataPrefix = process.env.TESSDATA_PREFIX;

    beforeAll(async () => {
      // Default reader (kreuzberg if available)
      reader = await getPDFReader();
      onnxReader = await getPDFReader({
        provider: 'auto',
        ocrProvider: 'onnx',
      });
      // unpdf reader for modular operations (extractImages, performOCR)
      unpdfReader = await getPDFReader({ provider: 'unpdf' });

      // Check if OCR is available before running OCR tests
      try {
        const deps = await checkOCRDependencies();
        ocrAvailable = deps.available;

        if (!ocrAvailable) {
          console.warn(
            'OCR not available - OCR integration test will be skipped',
          );
          console.warn('OCR unavailable reason:', deps.error);
        }
      } catch (error) {
        console.warn('Failed to check OCR dependencies:', error);
        ocrAvailable = false;
      }
    });

    afterAll(() => {
      if (originalTessdataPrefix) {
        process.env.TESSDATA_PREFIX = originalTessdataPrefix;
      } else {
        process.env.TESSDATA_PREFIX = undefined;
      }
    });

    it('should extract text from scanned PDF using OCR', async () => {
      const pdfPath = join(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        'test',
        'Signed-Meeting-Minutes-October-8-2024-Regular-Council-Meeting-1.pdf',
      );

      // Exercise tessdata auto-detection instead of relying on shell env state.
      process.env.TESSDATA_PREFIX = undefined;

      // Extract text - this MUST work for scanned PDFs
      // Both kreuzberg and unpdf handle OCR, just differently
      const text = await reader.extractText(pdfPath);

      // OCR must return actual text content, not null or empty
      expect(text).not.toBeNull();
      expect(text).toBeDefined();
      expect(typeof text).toBe('string');

      // Must extract meaningful content (at least 100 chars from a 3-page document)
      expect(text?.length).toBeGreaterThan(100);

      // Should contain expected content from the meeting minutes
      // (Bentley is the town name that appears in the document)
      expect(text?.toLowerCase()).toContain('bentley');

      console.log(`✅ OCR extracted ${text?.length} characters`);
      console.log(
        `Preview: ${text?.substring(0, 200).replace(/\s+/g, ' ').trim()}...`,
      );
    }, 60000);

    it('should extract text from scanned PDF using unpdf plus ONNX OCR', async () => {
      const pdfPath = join(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        'test',
        'Signed-Meeting-Minutes-October-8-2024-Regular-Council-Meeting-1.pdf',
      );

      const text = await onnxReader.extractText(pdfPath);

      expect(text).not.toBeNull();
      expect(text?.length).toBeGreaterThan(100);
      expect(text?.toLowerCase()).toContain('bentley');
    }, 60000);

    it('should perform OCR on extracted images (unpdf modular workflow)', async () => {
      if (!ocrAvailable) {
        console.log('⏭️ Skipping - OCR not available');
        return;
      }

      const pdfPath = join(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        'test',
        'Signed-Meeting-Minutes-October-8-2024-Regular-Council-Meeting-1.pdf',
      );

      // Extract embedded images from the PDF using unpdf (modular workflow)
      const images = await unpdfReader.extractImages(pdfPath);

      // Scanned PDF should have embedded images
      expect(images.length).toBeGreaterThan(0);
      console.log(`Extracted ${images.length} embedded images from PDF`);

      // Perform OCR on the first image
      const firstImage = images.slice(0, 1);
      const ocrResult = await unpdfReader.performOCR(firstImage, {
        language: 'eng',
        confidenceThreshold: 50,
      });

      expect(ocrResult).toBeDefined();
      expect(typeof ocrResult.text).toBe('string');
      expect(typeof ocrResult.confidence).toBe('number');

      // Should extract some text (embedded images may be logos/headers, not full pages)
      expect(ocrResult.text.length).toBeGreaterThan(0);
      expect(ocrResult.confidence).toBeGreaterThan(50);

      console.log(
        `✅ OCR on embedded image: "${ocrResult.text}" (${ocrResult.confidence.toFixed(1)}% confidence)`,
      );
    }, 60000);
  },
);
