/**
 * @happyvertical/pdf - Combined Node.js PDF reader with unpdf + OCR capabilities
 */

import { stat } from 'node:fs/promises';
import { getOCR } from '@happyvertical/ocr';
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
  PDFBatchExtractionError,
  PDFFileSizeError,
  PDFOCRFallbackError,
} from '../shared/types';
import {
  canUseChildExtraction,
  extractTextInChildProcess,
} from './child-extraction';
import { UnpdfProvider } from './unpdf';

const LARGE_DOCUMENT_BATCH_BYTES = 20 * 1024 * 1024;
const TEXT_BATCH_SIZE = 25;
const OCR_BATCH_SIZE = 4;
const HYBRID_BATCH_SIZE = 4;
const HYBRID_DIRECT_TEXT_MIN_CHARS_PER_PAGE = 50;
const HYBRID_OCR_CONFIDENCE_THRESHOLD = 85;
const HYBRID_OCR_LENGTH_ADVANTAGE_RATIO = 1.2;

/**
 * Combined PDF reader for Node.js that integrates unpdf and OCR capabilities
 *
 * This provider:
 * - Uses unpdf for text, metadata, and image extraction
 * - Falls back to OCR when direct text extraction yields no results
 * - Combines capabilities of both underlying providers
 */
export class CombinedNodeProvider extends BasePDFReader {
  protected name = 'combined-node';
  private unpdfProvider: UnpdfProvider;
  private ocrFactory: ReturnType<typeof getOCR>;
  private ocrProvider?: string;
  private defaultOCROptions?: OCROptions;
  private maxFileSize?: number;
  private timeout?: number;

  constructor(
    options: {
      ocrProvider?: string;
      defaultOCROptions?: OCROptions;
      maxFileSize?: number;
      timeout?: number;
    } = {},
  ) {
    super();
    this.unpdfProvider = new UnpdfProvider();
    this.ocrProvider = options.ocrProvider;
    this.ocrFactory = getOCR({ provider: options.ocrProvider || 'auto' });
    this.defaultOCROptions = options.defaultOCROptions;
    this.maxFileSize = options.maxFileSize;
    this.timeout = options.timeout;
  }

  private mergeOCROptions(options?: OCROptions): OCROptions | undefined {
    if (!this.defaultOCROptions && !options) {
      return undefined;
    }

    return {
      ...(this.defaultOCROptions || {}),
      ...(options || {}),
    };
  }

  private isInvalidSource(source: PDFSource): boolean {
    if (!source) {
      return true;
    }

    if (typeof source === 'string') {
      return source.trim() === '';
    }

    if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
      return source.byteLength === 0;
    }

    return typeof source === 'object' && Object.keys(source).length === 0;
  }

  private async getSourceByteLength(
    source: PDFSource,
  ): Promise<number | undefined> {
    if (typeof source === 'string') {
      try {
        const info = await stat(source);
        return info.size;
      } catch {
        return undefined;
      }
    }

    if (source instanceof Uint8Array) {
      return source.byteLength;
    }

    if (source instanceof ArrayBuffer) {
      return source.byteLength;
    }

    return undefined;
  }

  private async assertWithinConfiguredMaxFileSize(
    source: PDFSource,
    reportedFileSize?: number,
  ): Promise<void> {
    if (!this.maxFileSize) {
      return;
    }

    const fileSize =
      reportedFileSize ?? (await this.getSourceByteLength(source));
    if (!fileSize || fileSize <= this.maxFileSize) {
      return;
    }

    throw new PDFFileSizeError(fileSize, this.maxFileSize);
  }

  private shouldInspectForBatching(
    sourceByteLength: number | undefined,
    options?: ExtractTextOptions,
  ): boolean {
    if (sourceByteLength && sourceByteLength >= LARGE_DOCUMENT_BATCH_BYTES) {
      return true;
    }

    return Boolean(options?.pages && options.pages.length > OCR_BATCH_SIZE);
  }

  private shouldUseChildExtraction(
    sourceByteLength: number | undefined,
  ): boolean {
    return Boolean(
      canUseChildExtraction() &&
        sourceByteLength &&
        sourceByteLength >= LARGE_DOCUMENT_BATCH_BYTES,
    );
  }

  private childExtractText(
    source: PDFSource,
    options?: ExtractTextOptions,
  ): Promise<string | null> {
    return extractTextInChildProcess(
      source,
      options,
      {
        ocrProvider: this.ocrProvider,
        defaultOCROptions: this.defaultOCROptions,
        maxFileSize: this.maxFileSize,
      },
      this.timeout,
    );
  }

  private chunkPages(pages: number[], batchSize: number): number[][] {
    const batches: number[][] = [];

    for (let index = 0; index < pages.length; index += batchSize) {
      batches.push(pages.slice(index, index + batchSize));
    }

    return batches;
  }

  private shouldUseBatchedProcessing(
    info: PDFInfo,
    pagesToExtract: number[],
  ): boolean {
    if (pagesToExtract.length <= 1) {
      return false;
    }

    const fileSize = info.fileSize ?? 0;
    if (fileSize >= LARGE_DOCUMENT_BATCH_BYTES) {
      return true;
    }

    if (
      info.recommendedStrategy === 'ocr' ||
      info.recommendedStrategy === 'hybrid'
    ) {
      return pagesToExtract.length > OCR_BATCH_SIZE;
    }

    return pagesToExtract.length > TEXT_BATCH_SIZE;
  }

  private getBatchSizeForStrategy(
    strategy: PDFInfo['recommendedStrategy'],
  ): number {
    if (strategy === 'ocr') {
      return OCR_BATCH_SIZE;
    }

    if (strategy === 'hybrid') {
      return HYBRID_BATCH_SIZE;
    }

    return TEXT_BATCH_SIZE;
  }

  private formatPagesLabel(pages?: number[]): string {
    if (!pages?.length) {
      return 'all pages';
    }

    return pages.length > 1
      ? `pages ${pages[0]}-${pages[pages.length - 1]}`
      : `page ${pages[0]}`;
  }

  private async extractTextPageWise(
    source: PDFSource,
    pages: number[],
    strategy: PDFInfo['recommendedStrategy'],
    options?: ExtractTextOptions,
  ): Promise<string[]> {
    const pageTexts: string[] = [];

    for (const page of pages) {
      try {
        if (strategy === 'ocr') {
          pageTexts.push(await this.extractOcrBatchText(source, [page]));
        } else if (strategy === 'hybrid') {
          pageTexts.push(
            await this.extractHybridBatch(source, [page], options),
          );
        } else {
          pageTexts.push(await this.extractTextBatch(source, [page], options));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PDFBatchExtractionError([page], message);
      }
    }

    return pageTexts;
  }

  private async extractTextBatch(
    source: PDFSource,
    pages: number[],
    options?: ExtractTextOptions,
  ): Promise<string> {
    return (
      (await this.unpdfProvider.extractText(source, {
        ...options,
        pages,
        mergePages: true,
        skipOCRFallback: true,
      })) ?? ''
    ).trim();
  }

  private async extractOcrBatch(
    source: PDFSource,
    pages?: number[],
  ): Promise<OCRResult> {
    const renderedPages = await this.unpdfProvider.renderPages(source, {
      scale: 2.0,
      throwOnError: true,
      pages,
    });

    if (!renderedPages.length) {
      throw new PDFOCRFallbackError(
        `OCR fallback could not render ${this.formatPagesLabel(pages)}; renderPages returned no page images.`,
        pages,
      );
    }

    const ocrResult = await this.ocrFactory.performOCR(
      renderedPages,
      this.mergeOCROptions(),
    );
    const ocrText = ocrResult.text?.trim() || '';

    if (!ocrText) {
      const metadataProvider =
        typeof ocrResult.metadata?.provider === 'string'
          ? ` Provider: ${ocrResult.metadata.provider}.`
          : '';
      const confidence =
        typeof ocrResult.confidence === 'number'
          ? ` Confidence: ${ocrResult.confidence.toFixed(1)}.`
          : '';
      const detectionCount = Array.isArray(ocrResult.detections)
        ? ` Detections: ${ocrResult.detections.length}.`
        : '';

      throw new PDFOCRFallbackError(
        `OCR fallback produced no text for ${this.formatPagesLabel(pages)}.${metadataProvider}${confidence}${detectionCount}`,
        pages,
      );
    }

    return ocrResult;
  }

  private async extractOcrBatchText(
    source: PDFSource,
    pages?: number[],
  ): Promise<string> {
    const ocrResult = await this.extractOcrBatch(source, pages);
    return ocrResult.text?.trim() || '';
  }

  private async extractHybridBatch(
    source: PDFSource,
    pages: number[],
    options?: ExtractTextOptions,
  ): Promise<string> {
    const directText = await this.extractTextBatch(source, pages, options);
    const directTextLooksComplete =
      directText.length >= pages.length * HYBRID_DIRECT_TEXT_MIN_CHARS_PER_PAGE;

    if (directTextLooksComplete) {
      return directText;
    }

    try {
      const ocrResult = await this.extractOcrBatch(source, pages);
      const ocrText = ocrResult.text?.trim() || '';

      if (!ocrText) {
        return directText;
      }

      if (!directText) {
        return ocrText;
      }

      // Only prefer OCR when it is materially richer than the embedded text
      // and the OCR engine is reporting a meaningfully strong confidence score.
      const confidence = ocrResult.confidence ?? 0;
      return confidence >= HYBRID_OCR_CONFIDENCE_THRESHOLD &&
        ocrText.length > directText.length * HYBRID_OCR_LENGTH_ADVANTAGE_RATIO
        ? ocrText
        : directText;
    } catch (error) {
      if (directText) {
        return directText;
      }

      throw error;
    }
  }

  private async extractTextBatched(
    source: PDFSource,
    info: PDFInfo,
    pagesToExtract: number[],
    options?: ExtractTextOptions,
  ): Promise<string | null> {
    const strategy = options?.skipOCRFallback
      ? 'text'
      : info.recommendedStrategy;

    if (options?.mergePages !== true) {
      const pageTexts = await this.extractTextPageWise(
        source,
        pagesToExtract,
        strategy,
        options,
      );
      const mergedText = this.mergePageTexts(pageTexts, false);
      return mergedText.trim() ? mergedText : null;
    }

    const batchTexts: string[] = [];
    const batches = this.chunkPages(
      pagesToExtract,
      this.getBatchSizeForStrategy(strategy),
    );

    for (const pages of batches) {
      try {
        let batchText = '';

        if (strategy === 'ocr') {
          batchText = await this.extractOcrBatchText(source, pages);
        } else if (strategy === 'hybrid') {
          batchText = await this.extractHybridBatch(source, pages, options);
        } else {
          batchText = await this.extractTextBatch(source, pages, options);
        }

        batchTexts.push(batchText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PDFBatchExtractionError(pages, message);
      }
    }

    const mergedText = this.mergePageTexts(batchTexts, options?.mergePages);
    return mergedText.trim() ? mergedText : null;
  }

  /**
   * Extract text content from a PDF with OCR fallback
   */
  async extractText(
    source: PDFSource,
    options?: ExtractTextOptions,
  ): Promise<string | null> {
    if (this.isInvalidSource(source)) {
      return null;
    }

    let usingChildExtraction = false;

    try {
      const sourceByteLength = await this.getSourceByteLength(source);
      await this.assertWithinConfiguredMaxFileSize(source, sourceByteLength);

      if (this.shouldUseChildExtraction(sourceByteLength)) {
        usingChildExtraction = true;
        return await this.childExtractText(source, options);
      }

      if (this.shouldInspectForBatching(sourceByteLength, options)) {
        const info = await this.getInfo(source);

        if (info.pageCount > 0) {
          const pagesToExtract = this.normalizePages(
            options?.pages,
            info.pageCount,
          );

          if (
            pagesToExtract.length > 0 &&
            this.shouldUseBatchedProcessing(info, pagesToExtract)
          ) {
            return this.extractTextBatched(
              source,
              info,
              pagesToExtract,
              options,
            );
          }
        }
      }

      // First try direct text extraction using unpdf
      const text = await this.unpdfProvider.extractText(source, options);

      // If no text was found and OCR fallback is not disabled, try OCR
      if (!text?.trim() && !options?.skipOCRFallback) {
        console.log('No direct text found, attempting OCR fallback...');

        const fallbackInfo = await this.unpdfProvider.getInfo(source);
        if (fallbackInfo.pageCount <= 0) {
          return text;
        }

        try {
          return await this.extractOcrBatchText(source, options?.pages);
        } catch (ocrError) {
          if (ocrError instanceof PDFOCRFallbackError) {
            throw ocrError;
          }

          const message =
            ocrError instanceof Error ? ocrError.message : String(ocrError);
          throw new PDFOCRFallbackError(
            `OCR fallback failed for ${this.formatPagesLabel(options?.pages)}: ${message}`,
            options?.pages,
          );
        }
      }

      return text;
    } catch (error) {
      if (
        error instanceof PDFBatchExtractionError ||
        error instanceof PDFFileSizeError ||
        error instanceof PDFOCRFallbackError
      ) {
        throw error;
      }

      if (usingChildExtraction) {
        throw error;
      }

      console.error('Combined text extraction failed:', error);
      return null;
    }
  }

  /**
   * Extract metadata from a PDF using unpdf
   */
  async extractMetadata(source: PDFSource): Promise<PDFMetadata> {
    return this.unpdfProvider.extractMetadata(source);
  }

  /**
   * Extract images from a PDF using unpdf
   */
  async extractImages(
    source: PDFSource,
    options?: ExtractImagesOptions,
  ): Promise<PDFImage[]> {
    if (this.isInvalidSource(source)) {
      return [];
    }

    const sourceByteLength = await this.getSourceByteLength(source);
    await this.assertWithinConfiguredMaxFileSize(source, sourceByteLength);

    return this.unpdfProvider.extractImages(source, options);
  }

  /**
   * Render PDF pages as rasterized images using unpdf
   */
  async renderPages(
    source: PDFSource,
    options?: import('../shared/types.js').RenderPagesOptions,
  ): Promise<PDFImage[]> {
    return this.unpdfProvider.renderPages(source, options);
  }

  /**
   * Perform OCR on image data
   */
  async performOCR(
    images: PDFImage[],
    options?: OCROptions,
  ): Promise<OCRResult> {
    return this.ocrFactory.performOCR(images, this.mergeOCROptions(options));
  }

  /**
   * Check the combined capabilities of both providers
   */
  async checkCapabilities(): Promise<PDFCapabilities> {
    const [unpdfCaps, ocrAvailable] = await Promise.all([
      this.unpdfProvider.checkCapabilities(),
      this.ocrFactory.isOCRAvailable(),
    ]);

    // Get OCR languages if OCR is available
    let ocrLanguages: string[] = [];
    if (ocrAvailable) {
      ocrLanguages = await this.ocrFactory.getSupportedLanguages();
    }

    const maxFileSize =
      this.maxFileSize && unpdfCaps.maxFileSize
        ? Math.min(this.maxFileSize, unpdfCaps.maxFileSize)
        : (this.maxFileSize ?? unpdfCaps.maxFileSize);

    return {
      canExtractText: unpdfCaps.canExtractText || ocrAvailable, // Can extract text directly or via OCR
      canExtractMetadata: unpdfCaps.canExtractMetadata,
      canExtractImages: unpdfCaps.canExtractImages,
      canPerformOCR: ocrAvailable,
      supportedFormats: unpdfCaps.supportedFormats,
      maxFileSize,
      ocrLanguages: ocrLanguages.length > 0 ? ocrLanguages : undefined,
    };
  }

  /**
   * Check dependencies for both providers
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    const [unpdfDeps, ocrAvailable] = await Promise.all([
      this.unpdfProvider.checkDependencies(),
      this.ocrFactory.isOCRAvailable(),
    ]);

    // Get OCR provider info if available
    let ocrDetails = {};
    if (ocrAvailable) {
      const ocrProviders = await this.ocrFactory.getProvidersInfo();
      ocrDetails = { ocr: ocrAvailable, ocrProviders: ocrProviders.length };
    } else {
      ocrDetails = { ocr: false, ocrProviders: 0 };
    }

    // Combine dependency results
    const combinedDetails = {
      ...unpdfDeps.details,
      ...ocrDetails,
    };

    // This provider depends on both core unpdf parsing and page rendering.
    const available =
      unpdfDeps.details.unpdf === true &&
      unpdfDeps.details.pageRendering === true;

    let error: string | undefined;
    if (!available) {
      const errors = [unpdfDeps.error];
      if (!ocrAvailable) {
        errors.push('OCR not available');
      }
      error = errors.filter(Boolean).join('; ');
    }

    return {
      available,
      error,
      details: combinedDetails,
    };
  }

  /**
   * Get quick information about a PDF document combining both unpdf and OCR analysis
   */
  async getInfo(source: PDFSource): Promise<PDFInfo> {
    try {
      // First, get detailed analysis from unpdf provider (primary)
      const unpdfInfo = await this.unpdfProvider.getInfo(source);

      // Check OCR availability to enhance recommendations
      const ocrAvailable = await this.ocrFactory.isOCRAvailable();

      // Enhance the analysis with OCR-aware recommendations
      let enhancedStrategy = unpdfInfo.recommendedStrategy;
      let enhancedOcrRequired = unpdfInfo.ocrRequired;
      const enhancedProcessingTime = { ...unpdfInfo.estimatedProcessingTime };

      // If unpdf recommends OCR but OCR is not available, adjust strategy
      if (unpdfInfo.recommendedStrategy === 'ocr' && !ocrAvailable) {
        enhancedStrategy = 'text'; // Fall back to text-only
        enhancedOcrRequired = false;
        // Remove OCR processing time estimate
        enhancedProcessingTime.ocrProcessing = undefined;
      }

      // If unpdf recommends hybrid and OCR is not available, go text-only
      if (unpdfInfo.recommendedStrategy === 'hybrid' && !ocrAvailable) {
        enhancedStrategy = 'text';
        enhancedOcrRequired = false;
        enhancedProcessingTime.ocrProcessing = undefined;
      }

      // If OCR is available and document has images but little text, suggest hybrid
      if (
        ocrAvailable &&
        unpdfInfo.hasImages &&
        unpdfInfo.hasEmbeddedText &&
        unpdfInfo.estimatedTextLength &&
        unpdfInfo.estimatedTextLength < 1000
      ) {
        enhancedStrategy = 'hybrid';
        enhancedProcessingTime.ocrProcessing =
          unpdfInfo.pageCount > 10
            ? 'slow'
            : unpdfInfo.pageCount > 3
              ? 'medium'
              : 'fast';
      }

      return {
        ...unpdfInfo,
        recommendedStrategy: enhancedStrategy,
        ocrRequired: enhancedOcrRequired,
        estimatedProcessingTime: {
          textExtraction: enhancedProcessingTime.textExtraction || 'fast',
          ocrProcessing: enhancedProcessingTime.ocrProcessing,
        },
      };
    } catch (error) {
      console.error('Combined getInfo failed:', error);

      // Return minimal default info if unpdf fails
      return {
        pageCount: 0,
        encrypted: false,
        hasEmbeddedText: false,
        hasImages: false,
        recommendedStrategy: (await this.ocrFactory.isOCRAvailable())
          ? 'hybrid'
          : 'text',
        ocrRequired: false,
        estimatedProcessingTime: {
          textExtraction: 'fast',
        },
      };
    }
  }
}
