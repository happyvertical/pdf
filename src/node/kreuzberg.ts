/**
 * @happyvertical/pdf - Kreuzberg provider for memory-efficient PDF processing
 *
 * Uses @kreuzberg/node for Rust-based PDF text extraction with built-in OCR support.
 * Designed for processing large PDFs that would otherwise cause memory issues.
 */

import { promises as fs } from 'node:fs';
import { BasePDFReader } from '../shared/base';
import type {
  DependencyCheckResult,
  ExtractTextOptions,
  OCROptions,
  OCRResult,
  PDFCapabilities,
  PDFImage,
  PDFInfo,
  PDFMetadata,
  PDFSource,
} from '../shared/types';
import { PDFDependencyError, PDFUnsupportedError } from '../shared/types';

/**
 * Configuration options for the Kreuzberg provider
 */
export interface KreuzbergProviderOptions {
  /** OCR backend to use: 'tesseract' (default), or custom backend */
  ocrBackend?: string;
  /** OCR language (default: 'eng') */
  ocrLanguage?: string;
  /** Enable table detection during OCR */
  enableTableDetection?: boolean;
}

/**
 * PDF reader implementation using Kreuzberg (Rust-based) for Node.js
 *
 * This provider offers:
 * - Memory-efficient streaming for large PDFs
 * - Built-in OCR via Tesseract (with EasyOCR/PaddleOCR extensions available)
 * - Support for 56+ file formats
 * - Parallel batch processing in Rust
 *
 * @example
 * ```typescript
 * const reader = await getPDFReader({ provider: 'kreuzberg' });
 * const text = await reader.extractText('/path/to/large-document.pdf');
 * ```
 */
export class KreuzbergProvider extends BasePDFReader {
  protected name = 'kreuzberg';
  private kreuzberg: any = null;
  private options: KreuzbergProviderOptions;

  constructor(options: KreuzbergProviderOptions = {}) {
    super();
    this.options = {
      ocrBackend: options.ocrBackend || 'tesseract',
      ocrLanguage: options.ocrLanguage || 'eng',
      enableTableDetection: options.enableTableDetection ?? true,
    };
  }

  /**
   * Lazy load @kreuzberg/node
   */
  private async loadKreuzberg() {
    if (this.kreuzberg) {
      return this.kreuzberg;
    }

    try {
      this.kreuzberg = await import('@kreuzberg/node');
      return this.kreuzberg;
    } catch (error) {
      throw new PDFDependencyError(
        '@kreuzberg/node',
        `Install with: npm install @kreuzberg/node. Error: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Override normalizeSource to handle file reading in Node.js
   */
  protected async normalizeSource(source: PDFSource): Promise<Buffer> {
    if (typeof source === 'string') {
      try {
        const buffer = await fs.readFile(source);
        return buffer;
      } catch (error) {
        throw new Error(`Failed to read PDF file: ${(error as Error).message}`);
      }
    } else if (source instanceof Buffer) {
      return source;
    } else if (source instanceof Uint8Array) {
      return Buffer.from(source);
    } else {
      throw new Error(
        'Invalid PDF source: must be file path, Buffer, or Uint8Array',
      );
    }
  }

  /**
   * Build Kreuzberg extraction config from options
   */
  private buildConfig(options?: ExtractTextOptions) {
    const config: any = {};

    // Configure OCR if not explicitly skipped
    if (!options?.skipOCRFallback) {
      config.ocr = {
        backend: this.options.ocrBackend,
        language: this.options.ocrLanguage,
      };

      if (this.options.enableTableDetection) {
        config.ocr.tesseractConfig = {
          enableTableDetection: true,
        };
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  /**
   * Extract text content from a PDF using Kreuzberg
   *
   * Kreuzberg handles OCR internally when needed, making this a single
   * call that works for both text-based and scanned PDFs.
   */
  async extractText(
    source: PDFSource,
    options?: ExtractTextOptions,
  ): Promise<string | null> {
    // Handle invalid inputs gracefully
    if (
      !source ||
      (typeof source === 'string' && source.trim() === '') ||
      (typeof source === 'object' &&
        Object.keys(source).length === 0 &&
        !(source instanceof Buffer) &&
        !(source instanceof Uint8Array))
    ) {
      return null;
    }

    try {
      const kreuzberg = await this.loadKreuzberg();
      const config = this.buildConfig(options);

      let result;

      if (typeof source === 'string') {
        // File path - use extractFile for best performance
        result = await kreuzberg.extractFile(source, null, config);
      } else {
        // Buffer/Uint8Array - use extractBytes
        const buffer = await this.normalizeSource(source);
        result = await kreuzberg.extractBytes(
          buffer,
          'application/pdf',
          config,
        );
      }

      if (!result || !result.content) {
        return null;
      }

      return result.content;
    } catch (error) {
      console.error('Kreuzberg text extraction failed:', error);
      return null;
    }
  }

  /**
   * Extract metadata from a PDF using Kreuzberg
   */
  async extractMetadata(source: PDFSource): Promise<PDFMetadata> {
    try {
      const kreuzberg = await this.loadKreuzberg();

      let result;

      if (typeof source === 'string') {
        result = await kreuzberg.extractFile(source, null, null);
      } else {
        const buffer = await this.normalizeSource(source);
        result = await kreuzberg.extractBytes(buffer, 'application/pdf', null);
      }

      // Kreuzberg returns metadata in the result object
      const metadata = result?.metadata || {};

      return {
        pageCount: metadata.pageCount || metadata.page_count || 0,
        title: metadata.title || undefined,
        author: metadata.author || undefined,
        subject: metadata.subject || undefined,
        keywords: metadata.keywords || undefined,
        creationDate: metadata.creationDate
          ? new Date(metadata.creationDate)
          : undefined,
        modificationDate: metadata.modificationDate
          ? new Date(metadata.modificationDate)
          : undefined,
        version: metadata.pdfVersion || metadata.version || undefined,
        creator: metadata.creator || undefined,
        producer: metadata.producer || undefined,
        encrypted: metadata.encrypted || false,
      };
    } catch (error) {
      console.error('Kreuzberg metadata extraction failed:', error);
      return this.createDefaultMetadata(0);
    }
  }

  /**
   * Extract images from a PDF
   *
   * Note: Kreuzberg focuses on text extraction with integrated OCR.
   * For standalone image extraction, use the unpdf provider.
   */
  async extractImages(_source: PDFSource): Promise<PDFImage[]> {
    // Kreuzberg doesn't expose image extraction separately
    // It handles OCR internally during text extraction
    throw new PDFUnsupportedError(
      `extractImages (provider: ${this.name}) - Kreuzberg handles OCR internally. Use extractText() instead, or use unpdf provider for image extraction.`,
    );
  }

  /**
   * Render PDF pages as images
   *
   * Note: Kreuzberg handles page rendering internally for OCR.
   * This operation is not exposed separately.
   */
  async renderPages(_source: PDFSource): Promise<PDFImage[]> {
    throw new PDFUnsupportedError(
      `renderPages (provider: ${this.name}) - Kreuzberg handles page rendering internally for OCR. Use extractText() instead.`,
    );
  }

  /**
   * Perform OCR on images
   *
   * Note: Kreuzberg integrates OCR into the extraction pipeline.
   * Use extractText() which handles OCR automatically.
   */
  async performOCR(
    _images: PDFImage[],
    _options?: OCROptions,
  ): Promise<OCRResult> {
    throw new PDFUnsupportedError(
      `performOCR (provider: ${this.name}) - Kreuzberg integrates OCR into extractText(). Call extractText() instead.`,
    );
  }

  /**
   * Check the capabilities of the Kreuzberg provider
   */
  async checkCapabilities(): Promise<PDFCapabilities> {
    const deps = await this.checkDependencies();

    return {
      canExtractText: deps.available,
      canExtractMetadata: deps.available,
      canExtractImages: false, // Not exposed separately
      canPerformOCR: deps.available, // Integrated into extractText
      supportedFormats: [
        'pdf',
        'docx',
        'doc',
        'xlsx',
        'xls',
        'pptx',
        'ppt',
        'odt',
        'ods',
        'odp',
        'rtf',
        'txt',
        'html',
        'xml',
        'json',
        'csv',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'bmp',
        'tiff',
        'webp',
      ],
      maxFileSize: undefined, // Kreuzberg handles streaming for large files
      ocrLanguages: [
        'eng',
        'deu',
        'fra',
        'spa',
        'ita',
        'por',
        'nld',
        'chi_sim',
        'chi_tra',
        'jpn',
        'kor',
      ],
    };
  }

  /**
   * Check if Kreuzberg dependencies are available
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    try {
      await this.loadKreuzberg();

      return {
        available: true,
        details: {
          kreuzberg: true,
        },
      };
    } catch (error) {
      return {
        available: false,
        error: `Kreuzberg dependency not available: ${(error as Error).message}`,
        details: {
          kreuzberg: false,
        },
      };
    }
  }

  /**
   * Get quick information about a PDF document
   */
  async getInfo(source: PDFSource): Promise<PDFInfo> {
    try {
      const metadata = await this.extractMetadata(source);
      const buffer =
        typeof source === 'string'
          ? await fs.readFile(source)
          : await this.normalizeSource(source);

      // Kreuzberg doesn't provide detailed page analysis without full extraction
      // So we provide basic info from metadata
      return {
        pageCount: metadata.pageCount,
        fileSize: buffer.length,
        version: metadata.version,
        encrypted: metadata.encrypted || false,
        hasEmbeddedText: true, // Assume true - Kreuzberg will handle either case
        hasImages: true, // Assume true - Kreuzberg handles OCR if needed
        estimatedTextLength: undefined,
        recommendedStrategy: 'text', // Kreuzberg handles everything in one call
        ocrRequired: false, // Kreuzberg handles this automatically
        estimatedProcessingTime: {
          textExtraction:
            metadata.pageCount > 50
              ? 'slow'
              : metadata.pageCount > 10
                ? 'medium'
                : 'fast',
          ocrProcessing: undefined, // Integrated into text extraction
        },
        title: metadata.title,
        author: metadata.author,
        creationDate: metadata.creationDate,
        creator: metadata.creator,
        producer: metadata.producer,
      };
    } catch (error) {
      console.error('Kreuzberg getInfo failed:', error);

      return {
        pageCount: 0,
        encrypted: false,
        hasEmbeddedText: false,
        hasImages: false,
        recommendedStrategy: 'text',
        ocrRequired: false,
        estimatedProcessingTime: {
          textExtraction: 'fast',
        },
      };
    }
  }
}
