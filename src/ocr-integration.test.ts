import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkOCRDependencies, getPDFReader } from './index';
import type { PDFReader } from './shared/types';

describe.skipIf(process.env.CI === 'true')(
  'OCR Integration with Real PDF',
  () => {
    let reader: PDFReader;
    let ocrAvailable = false;

    beforeAll(async () => {
      reader = await getPDFReader();

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

    it('should extract text from scanned PDF using OCR', async () => {
      const pdfPath = join(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        'test',
        'Signed-Meeting-Minutes-October-8-2024-Regular-Council-Meeting-1.pdf',
      );

      // Verify this is a scanned PDF that requires OCR
      const info = await reader.getInfo(pdfPath);
      expect(info.ocrRequired).toBe(true);
      expect(info.recommendedStrategy).toBe('ocr');

      // Extract text - this MUST work for scanned PDFs
      const text = await reader.extractText(pdfPath);

      // OCR must return actual text content, not null or empty
      expect(text).not.toBeNull();
      expect(text).toBeDefined();
      expect(typeof text).toBe('string');

      // Must extract meaningful content (at least 100 chars from a 3-page document)
      expect(text!.length).toBeGreaterThan(100);

      // Should contain expected content from the meeting minutes
      // (Bentley is the town name that appears in the document)
      expect(text!.toLowerCase()).toContain('bentley');

      console.log(`✅ OCR extracted ${text!.length} characters`);
      console.log(
        `Preview: ${text!.substring(0, 200).replace(/\s+/g, ' ').trim()}...`,
      );
    }, 60000);

    it('should perform OCR on extracted images', async () => {
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

      // Extract embedded images from the PDF
      const images = await reader.extractImages(pdfPath);

      // Scanned PDF should have embedded images
      expect(images.length).toBeGreaterThan(0);
      console.log(`Extracted ${images.length} embedded images from PDF`);

      // Perform OCR on the first image
      const firstImage = images.slice(0, 1);
      const ocrResult = await reader.performOCR(firstImage, {
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
