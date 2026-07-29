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
  ExtractImagesOptions,
  ExtractTextOptions,
  OCROptions,
  OCRResult,
  PDFCapabilities,
  PDFImage,
  PDFInfo,
  PDFMetadata,
  PDFSource,
} from '../shared/types';
import {
  PDFDependencyError,
  PDFFileSizeError,
  PDFUnsupportedError,
} from '../shared/types';
import type {
  KreuzbergExtractionConfig,
  KreuzbergModule,
  KreuzbergResult,
} from './kreuzberg-runtime';
import { loadKreuzbergModule } from './kreuzberg-runtime';
import { ensureTessdataPrefix, formatPdfOcrRuntimeIssue } from './ocr-runtime';

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
  /** Optional configured max file size ceiling */
  maxFileSize?: number;
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
  private kreuzberg: KreuzbergModule | null = null;
  private options: KreuzbergProviderOptions;

  constructor(options: KreuzbergProviderOptions = {}) {
    super();
    this.options = {
      ocrBackend: options.ocrBackend || 'tesseract',
      ocrLanguage: options.ocrLanguage || 'eng',
      enableTableDetection: options.enableTableDetection ?? true,
      maxFileSize: options.maxFileSize,
    };
  }

  /**
   * Lazy load @kreuzberg/node
   *
   * Goes through the guarded runtime loader so that selecting this provider
   * explicitly on a host whose CPU cannot run the prebuilt binary fails with a
   * catchable error rather than a fatal signal.
   */
  private async loadKreuzberg() {
    if (this.kreuzberg) {
      return this.kreuzberg;
    }

    try {
      this.kreuzberg = await loadKreuzbergModule();
      return this.kreuzberg;
    } catch (error) {
      if (error instanceof PDFDependencyError) {
        // Already explains why the module is unusable — do not bury it under a
        // generic "install it" hint that would not help.
        throw error;
      }

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
    } else if (source instanceof ArrayBuffer) {
      return Buffer.from(source);
    } else {
      throw new Error(
        'Invalid PDF source: must be file path, Buffer, ArrayBuffer, or Uint8Array',
      );
    }
  }

  /**
   * Build Kreuzberg extraction config from options
   */
  private buildConfig(options?: ExtractTextOptions) {
    const config: KreuzbergExtractionConfig = {};

    // Configure OCR if not explicitly skipped
    if (!options?.skipOCRFallback) {
      const ocrConfig: NonNullable<KreuzbergExtractionConfig['ocr']> = {
        backend: this.options.ocrBackend || 'tesseract',
        language: this.options.ocrLanguage,
      };
      config.ocr = ocrConfig;

      if (this.options.enableTableDetection) {
        ocrConfig.tesseractConfig = {
          enableTableDetection: true,
        };
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  private async prepareOCRRuntime(options?: ExtractTextOptions) {
    if (options?.skipOCRFallback || this.options.ocrBackend !== 'tesseract') {
      return null;
    }

    return ensureTessdataPrefix(this.options.ocrLanguage);
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
      ((source instanceof Buffer ||
        source instanceof Uint8Array ||
        source instanceof ArrayBuffer) &&
        source.byteLength === 0)
    ) {
      return null;
    }

    let tessdata = null;
    let normalizedBuffer: Buffer | null = null;

    try {
      let sourceSize: number;
      if (typeof source === 'string') {
        sourceSize = (await fs.stat(source)).size;
      } else {
        normalizedBuffer = await this.normalizeSource(source);
        sourceSize = normalizedBuffer.byteLength;
      }

      if (this.options.maxFileSize && sourceSize > this.options.maxFileSize) {
        throw new PDFFileSizeError(sourceSize, this.options.maxFileSize);
      }

      tessdata = await this.prepareOCRRuntime(options);
      const kreuzberg = await this.loadKreuzberg();
      const config = this.buildConfig(options);

      let result: KreuzbergResult | null = null;

      if (typeof source === 'string') {
        // File path - use extractFile for best performance
        result = await kreuzberg.extractFile(source, null, config);
      } else {
        // Buffer/Uint8Array - use extractBytes
        const buffer = normalizedBuffer ?? (await this.normalizeSource(source));
        result = await kreuzberg.extractBytes(
          buffer,
          'application/pdf',
          config,
        );
      }

      if (!result?.content) {
        return null;
      }

      return result.content;
    } catch (error) {
      if (error instanceof PDFFileSizeError) {
        throw error;
      }

      const message = formatPdfOcrRuntimeIssue(error, {
        backend: this.options.ocrBackend,
        language: this.options.ocrLanguage,
        tessdata,
      });
      console.error('Kreuzberg text extraction failed:', message);
      return null;
    }
  }

  /**
   * Extract metadata from a PDF using Kreuzberg
   */
  async extractMetadata(source: PDFSource): Promise<PDFMetadata> {
    try {
      const kreuzberg = await this.loadKreuzberg();

      let result: KreuzbergResult | null = null;

      if (typeof source === 'string') {
        result = await kreuzberg.extractFile(source, null, null);
      } else {
        const buffer = await this.normalizeSource(source);
        result = await kreuzberg.extractBytes(buffer, 'application/pdf', null);
      }

      // Kreuzberg returns metadata in the result object
      const metadata = result?.metadata || {};
      const readString = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const value = metadata[key];
          if (typeof value === 'string') {
            return value;
          }
        }
        return undefined;
      };
      const readNumber = (...keys: string[]): number | undefined => {
        for (const key of keys) {
          const value = metadata[key];
          if (typeof value === 'number') {
            return value;
          }
        }
        return undefined;
      };
      const readBoolean = (...keys: string[]): boolean | undefined => {
        for (const key of keys) {
          const value = metadata[key];
          if (typeof value === 'boolean') {
            return value;
          }
        }
        return undefined;
      };
      const creationDate = readString('creationDate');
      const modificationDate = readString('modificationDate');

      return {
        pageCount: readNumber('pageCount', 'page_count') ?? 0,
        title: readString('title'),
        author: readString('author'),
        subject: readString('subject'),
        keywords: readString('keywords'),
        creationDate: creationDate ? new Date(creationDate) : undefined,
        modificationDate: modificationDate
          ? new Date(modificationDate)
          : undefined,
        version: readString('pdfVersion', 'version'),
        creator: readString('creator'),
        producer: readString('producer'),
        encrypted: readBoolean('encrypted', 'isEncrypted') ?? false,
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
  async extractImages(
    _source: PDFSource,
    _options?: ExtractImagesOptions,
  ): Promise<PDFImage[]> {
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
      maxFileSize: this.options.maxFileSize,
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
      const kreuzberg = await this.loadKreuzberg();
      const availableBackends =
        typeof kreuzberg.listOcrBackends === 'function'
          ? kreuzberg.listOcrBackends()
          : [];

      if (
        this.options.ocrBackend &&
        availableBackends.length > 0 &&
        !availableBackends.includes(this.options.ocrBackend)
      ) {
        return {
          available: false,
          error: formatPdfOcrRuntimeIssue(
            new Error(
              `OCR backend '${this.options.ocrBackend}' not registered`,
            ),
            {
              backend: this.options.ocrBackend,
            },
          ),
          details: {
            kreuzberg: true,
            ocrBackend: this.options.ocrBackend,
            ocrBackends: availableBackends,
          },
        };
      }

      const tessdata =
        this.options.ocrBackend === 'tesseract'
          ? await ensureTessdataPrefix(this.options.ocrLanguage)
          : null;

      if (this.options.ocrBackend === 'tesseract' && !tessdata?.path) {
        return {
          available: false,
          error: formatPdfOcrRuntimeIssue(
            new Error(
              `Failed to initialize language '${this.options.ocrLanguage}'`,
            ),
            {
              backend: this.options.ocrBackend,
              language: this.options.ocrLanguage,
              tessdata,
            },
          ),
          details: {
            kreuzberg: true,
            ocrBackend: this.options.ocrBackend,
            ocrBackends: availableBackends,
            tessdataChecked: tessdata?.checked || [],
            tessdataPrefix: process.env.TESSDATA_PREFIX || null,
          },
        };
      }

      return {
        available: true,
        details: {
          kreuzberg: true,
          ocrBackend: this.options.ocrBackend,
          ocrBackends: availableBackends,
          tessdataPrefix: process.env.TESSDATA_PREFIX || null,
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
