/**
 * @happyvertical/pdf - Combined Node.js PDF reader with unpdf + OCR capabilities
 */

import { stat } from 'node:fs/promises';
import { getOCR } from '@happyvertical/ocr';
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
import { UnpdfProvider } from './unpdf';

const LARGE_DOCUMENT_BATCH_BYTES = 20 * 1024 * 1024;
const TEXT_BATCH_SIZE = 25;
const OCR_BATCH_SIZE = 4;
const HYBRID_BATCH_SIZE = 4;
const HYBRID_DIRECT_TEXT_MIN_CHARS_PER_PAGE = 50;

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
  private maxFileSize?: number;

  constructor(options: { ocrProvider?: string; maxFileSize?: number } = {}) {
    super();
    this.unpdfProvider = new UnpdfProvider();
    this.ocrFactory = getOCR({ provider: options.ocrProvider || 'auto' });
    this.maxFileSize = options.maxFileSize;
  }

  private isInvalidSource(source: PDFSource): boolean {
    return (
      !source ||
      (typeof source === 'string' && source.trim() === '') ||
      (typeof source === 'object' &&
        Object.keys(source).length === 0 &&
        !(source instanceof Buffer) &&
        !(source instanceof Uint8Array))
    );
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

    const actualMB = (fileSize / 1024 / 1024).toFixed(1);
    const limitMB = (this.maxFileSize / 1024 / 1024).toFixed(1);
    throw new Error(
      `PDF exceeds configured maxFileSize (${actualMB}MB > ${limitMB}MB)`,
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
    options?: ExtractTextOptions,
  ): boolean {
    if (options?.pages && pagesToExtract.length <= 1) {
      return false;
    }

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

  private async extractTextPageWise(
    source: PDFSource,
    pages: number[],
    strategy: PDFInfo['recommendedStrategy'],
    options?: ExtractTextOptions,
  ): Promise<string[]> {
    const pageTexts: string[] = [];

    for (const page of pages) {
      if (strategy === 'ocr') {
        pageTexts.push(await this.extractOcrBatch(source, [page]));
      } else if (strategy === 'hybrid') {
        pageTexts.push(await this.extractHybridBatch(source, [page], options));
      } else {
        pageTexts.push(await this.extractTextBatch(source, [page], options));
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
    pages: number[],
  ): Promise<string> {
    const renderedPages = await this.unpdfProvider.renderPages(source, {
      scale: 2.0,
      pages,
    });

    if (!renderedPages.length) {
      return '';
    }

    const ocrResult = await this.ocrFactory.performOCR(renderedPages);
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
      const ocrText = await this.extractOcrBatch(source, pages);
      if (!ocrText) {
        return directText;
      }

      if (!directText) {
        return ocrText;
      }

      return ocrText.length > directText.length * 1.2 ? ocrText : directText;
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

    if (options?.mergePages === false) {
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
      const batchLabel = `${pages[0]}-${pages[pages.length - 1]}`;

      try {
        let batchText = '';

        if (strategy === 'ocr') {
          batchText = await this.extractOcrBatch(source, pages);
        } else if (strategy === 'hybrid') {
          batchText = await this.extractHybridBatch(source, pages, options);
        } else {
          batchText = await this.extractTextBatch(source, pages, options);
        }

        batchTexts.push(batchText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Large PDF extraction failed for pages ${batchLabel}: ${message}`,
        );
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

    try {
      const info = await this.getInfo(source);
      await this.assertWithinConfiguredMaxFileSize(source, info.fileSize);

      if (info.pageCount > 0) {
        const pagesToExtract = this.normalizePages(
          options?.pages,
          info.pageCount,
        );

        if (
          pagesToExtract.length > 0 &&
          this.shouldUseBatchedProcessing(info, pagesToExtract, options)
        ) {
          return this.extractTextBatched(source, info, pagesToExtract, options);
        }
      }

      // First try direct text extraction using unpdf
      const text = await this.unpdfProvider.extractText(source, options);

      // If no text was found and OCR fallback is not disabled, try OCR
      if (!text?.trim() && !options?.skipOCRFallback) {
        console.log('No direct text found, attempting OCR fallback...');

        try {
          // Use renderPages() instead of extractImages() for full-page OCR
          // This renders the PDF pages as images, capturing all text as pixels
          const renderedPages = await this.unpdfProvider.renderPages(source, {
            scale: 2.0, // 2x scale for better OCR quality
            pages: options?.pages, // Respect page selection if provided
          });

          if (renderedPages && renderedPages.length > 0) {
            const ocrResult = await this.ocrFactory.performOCR(renderedPages);
            return ocrResult.text || null;
          }
        } catch (ocrError) {
          console.warn('OCR fallback failed:', ocrError);
        }
      }

      return text;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('Large PDF extraction failed') ||
          error.message.includes('configured maxFileSize'))
      ) {
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
  async extractImages(source: PDFSource): Promise<PDFImage[]> {
    return this.unpdfProvider.extractImages(source);
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
    return this.ocrFactory.performOCR(images, options);
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
