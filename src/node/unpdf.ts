/**
 * @happyvertical/pdf - unpdf provider for Node.js PDF processing
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CanvasRenderingContext2D as NapiCanvasRenderingContext2D,
  SKRSContext2D,
} from '@napi-rs/canvas';
import { Canvas } from '@napi-rs/canvas';
import type {
  DocumentInitParameters,
  PDFPageProxy,
  RenderParameters,
  TextItem,
} from 'pdfjs-dist/types/src/display/api';
import { BasePDFReader } from '../shared/base';
import { detectImageMimeFromMagicBytes } from '../shared/image-format';
import type {
  DependencyCheckResult,
  ExtractImagesOptions,
  ExtractTextOptions,
  PDFCapabilities,
  PDFImage,
  PDFInfo,
  PDFMetadata,
  PDFSource,
  RenderPagesOptions,
} from '../shared/types';
import {
  PDFBatchExtractionError,
  PDFDependencyError,
  PDFImageCollectionLimitError,
  PDFOCRFallbackError,
} from '../shared/types';
import { applyOutputFormat, canonicalizeImageFormat } from './image-encoding';
import { formatPdfOcrRuntimeIssue } from './ocr-runtime';

const DEFAULT_EXTRACT_IMAGES_OUTPUT_FORMAT: NonNullable<
  ExtractImagesOptions['outputFormat']
> = 'webp';
const DEFAULT_RENDER_PAGES_OUTPUT_FORMAT: NonNullable<
  RenderPagesOptions['outputFormat']
> = 'original';

const require = createRequire(import.meta.url);
const IMAGE_EXTRACTION_BATCH_SIZE = 4;
const DEFAULT_MAX_COLLECTED_IMAGE_BYTES = 128 * 1024 * 1024;

type UnpdfModule = typeof import('unpdf');
type UnpdfDocumentProxy = Awaited<ReturnType<UnpdfModule['getDocumentProxy']>>;
type UnpdfExtractedImage = {
  data: Buffer | Uint8Array | Uint8ClampedArray | ArrayBuffer;
  width?: number;
  height?: number;
  channels?: number;
};
type TextMarkedContent = { type: string; id: string };
type NodeRenderableContext = NapiCanvasRenderingContext2D | SKRSContext2D;
type PDFMetadataInfo = Record<string, unknown>;
type PdfjsDocumentOptions = Pick<DocumentInitParameters, 'useWorkerFetch'> &
  Partial<Pick<DocumentInitParameters, 'standardFontDataUrl' | 'wasmUrl'>>;
type LoadPdfDocumentOptions = {
  includeOptionalAssets?: boolean;
};

function readTextItem(item: TextItem | TextMarkedContent): string {
  return 'str' in item ? item.str : '';
}

function createNodeRenderParameters(
  page: PDFPageProxy,
  canvasContext: NodeRenderableContext,
  scale: number,
): RenderParameters {
  return {
    canvas: null,
    canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
    viewport: page.getViewport({ scale }),
  };
}

function getMetadataInfoValue(
  info: object | null | undefined,
  key: string,
): string | undefined {
  const value = (info as PDFMetadataInfo | null | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getMetadataInfoDate(
  info: object | null | undefined,
  key: string,
): Date | undefined {
  const value = getMetadataInfoValue(info, key);
  return value ? new Date(value) : undefined;
}

/**
 * PDF reader implementation using unpdf library for Node.js
 *
 * This provider handles:
 * - Text extraction from PDF files
 * - Image extraction from PDF files
 * - Basic metadata extraction
 */
export class UnpdfProvider extends BasePDFReader {
  protected name = 'unpdf';
  private unpdf: UnpdfModule | null = null;
  private unpdfLoadPromise: Promise<UnpdfModule> | null = null;
  private configuredPdfjsWorkerSrc: string | null = null;
  private hasConfiguredUnpdfPdfjsModule = false;
  private pdfjsRenderDocumentOptions: PdfjsDocumentOptions | null = null;

  private rgbaToRgbBuffer(data: Uint8ClampedArray): Buffer {
    const rgbData = Buffer.alloc((data.length / 4) * 3);

    for (
      let sourceIndex = 0, targetIndex = 0;
      sourceIndex < data.length;
      sourceIndex += 4
    ) {
      rgbData[targetIndex++] = data[sourceIndex];
      rgbData[targetIndex++] = data[sourceIndex + 1];
      rgbData[targetIndex++] = data[sourceIndex + 2];
    }

    return rgbData;
  }

  /**
   * Lazy load unpdf dependencies
   */
  private async loadUnpdf() {
    if (this.unpdf) {
      return this.unpdf;
    }

    if (!this.unpdfLoadPromise) {
      this.unpdfLoadPromise = (async () => {
        const unpdf = await import('unpdf');
        await this.ensureUnpdfPdfjsRuntime(unpdf);
        this.unpdf = unpdf;
        return unpdf;
      })();
    }

    try {
      return await this.unpdfLoadPromise;
    } catch (error) {
      this.unpdfLoadPromise = null;
      this.unpdf = null;
      throw new PDFDependencyError('unpdf', (error as Error).message);
    }
  }

  private async ensureUnpdfPdfjsRuntime(
    unpdf: Pick<UnpdfModule, 'definePDFJSModule'>,
  ) {
    if (!this.hasConfiguredUnpdfPdfjsModule) {
      await unpdf.definePDFJSModule(
        () => import('pdfjs-dist/legacy/build/pdf.mjs'),
      );
      this.hasConfiguredUnpdfPdfjsModule = true;
    }
  }

  private formatPdfjsAssetDirectory(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  private resolveOptionalPdfjsAssetDirectory(
    specifier: string,
  ): string | undefined {
    try {
      return this.formatPdfjsAssetDirectory(
        dirname(require.resolve(specifier)),
      );
    } catch {
      return undefined;
    }
  }

  private getPdfjsDocumentOptions(
    includeOptionalAssets = false,
  ): PdfjsDocumentOptions {
    if (!includeOptionalAssets) {
      return {
        useWorkerFetch: false,
      };
    }

    if (!this.pdfjsRenderDocumentOptions) {
      // These assets are optional package extras in some deployments, so keep
      // text/metadata flows working even when bundlers trim rendering assets.
      const standardFontDataUrl = this.resolveOptionalPdfjsAssetDirectory(
        'pdfjs-dist/standard_fonts/FoxitSymbol.pfb',
      );
      const wasmUrl = this.resolveOptionalPdfjsAssetDirectory(
        'pdfjs-dist/wasm/openjpeg.wasm',
      );

      this.pdfjsRenderDocumentOptions = {
        useWorkerFetch: false,
        ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
        ...(wasmUrl ? { wasmUrl } : {}),
      };
    }

    return this.pdfjsRenderDocumentOptions;
  }

  private async ensurePdfjsWorkerConfigured() {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const workerPath = require.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
    );
    const workerSrc = pathToFileURL(workerPath).href;

    pdfjs.GlobalWorkerOptions.workerPort = null;

    if (this.configuredPdfjsWorkerSrc !== workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      this.configuredPdfjsWorkerSrc = workerSrc;
    }
  }

  private async verifyRenderDependencies() {
    await this.ensurePdfjsWorkerConfigured();

    const canvas = new Canvas(1, 1);
    const context = canvas.getContext('2d');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * Override normalizeSource to handle file reading in Node.js
   */
  protected async normalizeSource(source: PDFSource): Promise<Uint8Array> {
    if (typeof source === 'string') {
      try {
        const buffer = await fs.readFile(source);
        return new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        );
      } catch (error) {
        throw new Error(`Failed to read PDF file: ${(error as Error).message}`);
      }
    } else if (source instanceof Buffer) {
      return new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
    } else if (source instanceof ArrayBuffer) {
      return new Uint8Array(source);
    } else if (source instanceof Uint8Array) {
      return source;
    } else {
      throw new Error(
        'Invalid PDF source: must be file path, Buffer, ArrayBuffer, or Uint8Array',
      );
    }
  }

  /**
   * Extract text content from a PDF using unpdf
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
        !(source instanceof ArrayBuffer) &&
        !(source instanceof Uint8Array))
    ) {
      return null;
    }

    try {
      const unpdf = await this.loadUnpdf();
      const pdf = await this.loadPDFDocument(unpdf, source);

      try {
        const totalPages = pdf.numPages;

        // Normalize pages to extract
        const pagesToExtract = this.normalizePages(options?.pages, totalPages);

        if (pagesToExtract.length === 0) {
          return null;
        }

        // Extract text from specified pages
        const pageTexts: string[] = [];

        for (const pageNum of pagesToExtract) {
          try {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Combine text items into a single string
            const pageText = textContent.items
              .map(readTextItem)
              .join(' ')
              .trim();

            pageTexts.push(pageText);
          } catch (pageError) {
            console.warn(
              `Failed to extract text from page ${pageNum}:`,
              pageError,
            );
            pageTexts.push(''); // Add empty string to maintain page order
          }
        }

        // Merge page texts according to options
        const mergedText = this.mergePageTexts(pageTexts, options?.mergePages);

        return mergedText || null;
      } finally {
        await this.closePDFDocument(pdf);
      }
    } catch (error) {
      console.error('unpdf text extraction failed:', error);
      return null;
    }
  }

  /**
   * Extract metadata from a PDF using unpdf
   */
  async extractMetadata(source: PDFSource): Promise<PDFMetadata> {
    try {
      const unpdf = await this.loadUnpdf();
      const pdf = await this.loadPDFDocument(unpdf, source);

      try {
        const metadata = await pdf.getMetadata();

        return {
          pageCount: pdf.numPages,
          title: getMetadataInfoValue(metadata?.info, 'Title'),
          author: getMetadataInfoValue(metadata?.info, 'Author'),
          subject: getMetadataInfoValue(metadata?.info, 'Subject'),
          keywords: getMetadataInfoValue(metadata?.info, 'Keywords'),
          creationDate: getMetadataInfoDate(metadata?.info, 'CreationDate'),
          modificationDate: getMetadataInfoDate(metadata?.info, 'ModDate'),
          version: getMetadataInfoValue(metadata?.info, 'PDFFormatVersion'),
          creator: getMetadataInfoValue(metadata?.info, 'Creator'),
          producer: getMetadataInfoValue(metadata?.info, 'Producer'),
          encrypted:
            getMetadataInfoValue(metadata?.info, 'Encrypted') === 'Yes',
        };
      } finally {
        await this.closePDFDocument(pdf);
      }
    } catch (error) {
      console.error('unpdf metadata extraction failed:', error);
      // Return default metadata with at least page count if possible
      try {
        const unpdf = await this.loadUnpdf();
        const pdf = await this.loadPDFDocument(unpdf, source);

        try {
          return this.createDefaultMetadata(pdf.numPages);
        } finally {
          await this.closePDFDocument(pdf);
        }
      } catch {
        return this.createDefaultMetadata(0);
      }
    }
  }

  /**
   * No conversion needed! Direct RGB data is now supported by the new ONNX provider.
   * This is the optimal path for OCR processing from unpdf.
   */
  private processRawRGBData(
    rgbData: Buffer,
    _width: number,
    _height: number,
  ): Buffer {
    // Return raw RGB data directly - no conversion overhead!
    return rgbData;
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

  private normalizeImageBatchSize(batchSize?: number): number {
    if (!batchSize || !Number.isFinite(batchSize) || batchSize < 1) {
      return IMAGE_EXTRACTION_BATCH_SIZE;
    }

    return Math.floor(batchSize);
  }

  private normalizeMaxCollectedImageBytes(maxCollectedBytes?: number): number {
    if (maxCollectedBytes === undefined) {
      return DEFAULT_MAX_COLLECTED_IMAGE_BYTES;
    }

    if (!Number.isFinite(maxCollectedBytes) || maxCollectedBytes < 0) {
      return DEFAULT_MAX_COLLECTED_IMAGE_BYTES;
    }

    return Math.floor(maxCollectedBytes);
  }

  private getImageByteLength(image: PDFImage): number {
    if (typeof image.data === 'string') {
      return Buffer.byteLength(image.data);
    }

    return image.data.byteLength;
  }

  private chunkPages(pages: number[], batchSize: number): number[][] {
    const batches: number[][] = [];

    for (let index = 0; index < pages.length; index += batchSize) {
      batches.push(pages.slice(index, index + batchSize));
    }

    return batches;
  }

  private async loadPDFDocument(
    unpdf: UnpdfModule,
    source: PDFSource,
    options?: LoadPdfDocumentOptions,
  ): Promise<UnpdfDocumentProxy> {
    if (options?.includeOptionalAssets) {
      await this.ensurePdfjsWorkerConfigured();
    }

    const buffer = await this.normalizeSource(source);

    if (!this.validatePDFData(buffer)) {
      throw new Error('Invalid PDF data');
    }

    // Clone in-memory sources so PDF.js worker transfer does not detach caller-owned buffers.
    const documentData =
      typeof source === 'string' ? buffer : new Uint8Array(buffer);
    return unpdf.getDocumentProxy(
      documentData,
      this.getPdfjsDocumentOptions(options?.includeOptionalAssets),
    );
  }

  private async closePDFDocument(pdf: UnpdfDocumentProxy): Promise<void> {
    try {
      await pdf.cleanup?.();
    } catch {
      // Best-effort cleanup; destroy below is the important release path.
    }

    try {
      await pdf.destroy?.();
    } catch {
      // Ignore cleanup failures so extraction errors remain the caller-visible failure.
    }
  }

  private async getPageCount(
    unpdf: UnpdfModule,
    source: PDFSource,
  ): Promise<number> {
    const pdf = await this.loadPDFDocument(unpdf, source);

    try {
      return pdf.numPages;
    } finally {
      await this.closePDFDocument(pdf);
    }
  }

  private async getSourceFileSize(
    source: PDFSource,
  ): Promise<number | undefined> {
    if (typeof source === 'string') {
      try {
        return (await fs.stat(source)).size;
      } catch {
        return undefined;
      }
    }

    if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
      return source.byteLength;
    }

    return undefined;
  }

  private convertExtractedImage(
    image: UnpdfExtractedImage,
    pageNumber: number,
  ): PDFImage {
    const rawData = this.convertImageDataToBuffer(image.data);
    let processedData: Buffer = rawData;
    let bitsPerComponent: number | undefined;

    // unpdf normalizes raw pixel streams to 8-bit Uint8ClampedArray with a
    // matching channel layout. When the byte length confirms the layout,
    // hand the optimal raw RGB path to OCR.
    const { width, height, channels } = image;
    const isRawPixelLayout =
      channels !== undefined &&
      width !== undefined &&
      height !== undefined &&
      rawData.length === width * height * channels;

    if (isRawPixelLayout && width !== undefined && height !== undefined) {
      if (channels === 3) {
        processedData = this.processRawRGBData(rawData, width, height);
      }
      bitsPerComponent = 8;
    }

    // Canonicalize `format` to a lowercase IANA mime type per #74.
    //
    // Priority (per the issue #74 reviewer guidance): infer raw
    // `image/x-*` *only* when the byte-length check confirms a raw 8-bit
    // layout. This prevents a raw RGB buffer that happens to start with
    // a JPEG SOI marker (e.g. pixel value 0xFF 0xD8 0xFF) from being
    // sniffed as JPEG. When the byte-length disagrees (encoded stream),
    // sniff magic bytes; if no signature matches, fall back to
    // application/octet-stream rather than guessing.
    let format: PDFImage['format'];
    if (isRawPixelLayout) {
      format = canonicalizeImageFormat(undefined, image.channels);
    } else {
      format =
        detectImageMimeFromMagicBytes(rawData) ?? 'application/octet-stream';
    }

    return {
      data: processedData,
      width: image.width,
      height: image.height,
      channels: image.channels,
      bitsPerComponent,
      format,
      pageNumber,
    };
  }

  private convertImageDataToBuffer(data: UnpdfExtractedImage['data']): Buffer {
    if (data instanceof Buffer) {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    return Buffer.from(data);
  }

  private async extractImageBatch(
    unpdf: UnpdfModule,
    source: PDFSource,
    pages: number[],
  ): Promise<PDFImage[]> {
    const pdf = await this.loadPDFDocument(unpdf, source, {
      includeOptionalAssets: true,
    });
    const batchImages: PDFImage[] = [];

    try {
      for (const pageNum of pages) {
        try {
          const images = await unpdf.extractImages(pdf, pageNum);

          for (const image of images) {
            batchImages.push(
              this.convertExtractedImage(image as UnpdfExtractedImage, pageNum),
            );
          }
        } catch (pageError) {
          const message =
            pageError instanceof Error ? pageError.message : String(pageError);
          throw new PDFBatchExtractionError([pageNum], message);
        }
      }

      return batchImages;
    } finally {
      await this.closePDFDocument(pdf);
    }
  }

  /**
   * Extract images from a PDF using unpdf
   */
  async extractImages(
    source: PDFSource,
    options?: ExtractImagesOptions,
  ): Promise<PDFImage[]> {
    // Handle invalid inputs gracefully
    if (this.isInvalidSource(source)) {
      return [];
    }

    const unpdf = await this.loadUnpdf();
    const totalPages = await this.getPageCount(unpdf, source);
    const pagesToExtract = this.normalizePages(options?.pages, totalPages);

    if (pagesToExtract.length === 0) {
      return [];
    }

    const batches = this.chunkPages(
      pagesToExtract,
      this.normalizeImageBatchSize(options?.batchSize),
    );
    const shouldCollect = options?.collect ?? !options?.onBatch;
    const maxCollectedBytes = this.normalizeMaxCollectedImageBytes(
      options?.maxCollectedBytes,
    );
    const outputFormat =
      options?.outputFormat ?? DEFAULT_EXTRACT_IMAGES_OUTPUT_FORMAT;
    const allImages: PDFImage[] = [];
    let collectedBytes = 0;

    for (const [batchIndex, pages] of batches.entries()) {
      let images: PDFImage[];

      try {
        images = await this.extractImageBatch(unpdf, source, pages);
      } catch (error) {
        if (error instanceof PDFBatchExtractionError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new PDFBatchExtractionError(pages, message);
      }

      // Re-encode to the requested web-safe format before any size
      // accounting so the byte budget reflects what the caller will hold
      // onto. WebP / JPEG outputs are typically 5-20x smaller than the
      // raw RGB buffers, so the safety limit becomes more permissive.
      images = await applyOutputFormat(
        images,
        outputFormat,
        options?.encodingOptions,
      );

      let nextCollectedBytes = collectedBytes;

      if (shouldCollect) {
        const batchBytes = images.reduce(
          (total, image) => total + this.getImageByteLength(image),
          0,
        );
        nextCollectedBytes = collectedBytes + batchBytes;
        if (nextCollectedBytes > maxCollectedBytes) {
          throw new PDFImageCollectionLimitError(
            nextCollectedBytes,
            maxCollectedBytes,
          );
        }
      }

      await options?.onBatch?.({
        images,
        pages,
        batchIndex,
        totalBatches: batches.length,
      });

      if (shouldCollect) {
        for (const image of images) {
          allImages.push(image);
        }
        collectedBytes = nextCollectedBytes;
      }
    }

    return allImages;
  }

  /**
   * Render PDF pages as rasterized images for OCR processing
   *
   * Uses pdf-to-png-converter to render each PDF page as a high-quality PNG image.
   * This is essential for OCR on PDFs where text is rendered (not embedded).
   */
  async renderPages(
    source: PDFSource,
    options?: RenderPagesOptions,
  ): Promise<PDFImage[]> {
    // Handle invalid inputs gracefully
    if (this.isInvalidSource(source)) {
      return [];
    }

    try {
      await this.ensurePdfjsWorkerConfigured();
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const buffer = await this.normalizeSource(source);

      if (!this.validatePDFData(buffer)) {
        throw new Error('Invalid PDF data');
      }

      const document = await pdfjs.getDocument({
        data: buffer,
        ...this.getPdfjsDocumentOptions(true),
      }).promise;

      try {
        const pagesToRender = this.normalizePages(
          options?.pages,
          document.numPages,
        );
        const images: PDFImage[] = [];
        const outputFormat =
          options?.outputFormat ?? DEFAULT_RENDER_PAGES_OUTPUT_FORMAT;

        for (const pageNumber of pagesToRender) {
          const page = await document.getPage(pageNumber);
          const scale = options?.scale || 2.0;
          const viewport = page.getViewport({ scale });
          const width = Math.ceil(viewport.width);
          const height = Math.ceil(viewport.height);
          const canvas = new Canvas(width, height);
          const context = canvas.getContext('2d');

          try {
            await page.render(createNodeRenderParameters(page, context, scale))
              .promise;

            const imageData = context.getImageData(0, 0, width, height);

            images.push({
              data: this.rgbaToRgbBuffer(imageData.data),
              format: canonicalizeImageFormat(undefined, 3),
              pageNumber,
              width,
              height,
              channels: 3,
              bitsPerComponent: 8,
            });
          } finally {
            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;
          }
        }

        return applyOutputFormat(
          images,
          outputFormat,
          options?.encodingOptions,
        );
      } finally {
        await document.destroy();
      }
    } catch (error) {
      const message = formatPdfOcrRuntimeIssue(error);
      console.error('unpdf page rendering failed:', message);
      if (options?.throwOnError) {
        throw new PDFOCRFallbackError(
          `PDF page rendering failed during OCR fallback: ${message}`,
          options.pages,
        );
      }
      return [];
    }
  }

  /**
   * Check the capabilities of the unpdf provider
   */
  async checkCapabilities(): Promise<PDFCapabilities> {
    const deps = await this.checkDependencies();
    const coreUnpdfAvailable = deps.details.unpdf === true;

    return {
      canExtractText: coreUnpdfAvailable,
      canExtractMetadata: coreUnpdfAvailable,
      canExtractImages: coreUnpdfAvailable,
      canPerformOCR: false, // unpdf doesn't do OCR
      supportedFormats: ['pdf'],
      maxFileSize: undefined, // No explicit limit
      ocrLanguages: undefined,
    };
  }

  /**
   * Check if unpdf dependencies are available
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    let unpdfAvailable = false;
    let pageRenderingAvailable = false;
    const errors: string[] = [];

    try {
      await this.loadUnpdf();
      unpdfAvailable = true;
    } catch (error) {
      errors.push(`unpdf import unavailable: ${(error as Error).message}`);
    }

    if (unpdfAvailable) {
      try {
        await this.verifyRenderDependencies();
        pageRenderingAvailable = true;
      } catch (error) {
        errors.push(
          `page rendering unavailable: ${formatPdfOcrRuntimeIssue(error)}`,
        );
      }
    }

    return {
      available: unpdfAvailable && pageRenderingAvailable,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      details: {
        unpdf: unpdfAvailable,
        pageRendering: pageRenderingAvailable,
      },
    };
  }

  /**
   * Get quick information about a PDF document
   */
  async getInfo(source: PDFSource): Promise<PDFInfo> {
    try {
      const unpdf = await this.loadUnpdf();
      const pdf = await this.loadPDFDocument(unpdf, source);
      const fileSize = await this.getSourceFileSize(source);

      try {
        const metadata = await pdf.getMetadata();

        // Quick analysis of document structure
        const pageCount = pdf.numPages;
        let hasEmbeddedText = false;
        let hasImages = false;
        let estimatedTextLength = 0;

        // Sample first few pages to determine content type
        const pagesToSample = Math.min(3, pageCount);
        for (let i = 1; i <= pagesToSample; i++) {
          try {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();

            if (content.items && content.items.length > 0) {
              hasEmbeddedText = true;
              // Estimate text length based on sample
              const pageTextLength = content.items.reduce(
                (len: number, item: TextItem | TextMarkedContent) =>
                  len + readTextItem(item).length,
                0,
              );
              estimatedTextLength += pageTextLength;
            }

            // Check for images (simplified check for rendering operations)
            const ops = await page.getOperatorList();
            if (ops.fnArray?.some((op: number) => op === 82 || op === 85)) {
              // paintImageXObject operations
              hasImages = true;
            }
          } catch (pageError) {
            // Skip problematic pages
            console.warn(`Failed to analyze page ${i}:`, pageError);
          }
        }

        // Scale estimated text length to full document
        if (estimatedTextLength > 0 && pageCount > pagesToSample) {
          estimatedTextLength = Math.round(
            (estimatedTextLength / pagesToSample) * pageCount,
          );
        }

        // Determine processing strategy
        let recommendedStrategy: 'text' | 'ocr' | 'hybrid';
        let ocrRequired = false;

        if (hasEmbeddedText) {
          if (hasImages && estimatedTextLength < 500) {
            // Has embedded text but very little - might need OCR for images
            recommendedStrategy = 'hybrid';
            ocrRequired = false;
          } else {
            // Sufficient embedded text
            recommendedStrategy = 'text';
            ocrRequired = false;
          }
        } else {
          // No embedded text found - likely image-based PDF
          recommendedStrategy = 'ocr';
          ocrRequired = true;
        }

        // Estimate processing times
        const estimatedProcessingTime = {
          textExtraction: hasEmbeddedText
            ? ((estimatedTextLength > 50000 ? 'medium' : 'fast') as
                | 'fast'
                | 'medium'
                | 'slow')
            : ('fast' as 'fast' | 'medium' | 'slow'),
          ocrProcessing:
            hasImages || ocrRequired
              ? ((pageCount > 10
                  ? 'slow'
                  : pageCount > 3
                    ? 'medium'
                    : 'fast') as 'fast' | 'medium' | 'slow')
              : undefined,
        };

        return {
          pageCount,
          fileSize,
          version: getMetadataInfoValue(metadata?.info, 'PDFFormatVersion'),
          encrypted:
            getMetadataInfoValue(metadata?.info, 'Encrypted') === 'Yes',
          hasEmbeddedText,
          hasImages,
          estimatedTextLength:
            estimatedTextLength > 0 ? estimatedTextLength : undefined,
          recommendedStrategy,
          ocrRequired,
          estimatedProcessingTime,
          title: getMetadataInfoValue(metadata?.info, 'Title'),
          author: getMetadataInfoValue(metadata?.info, 'Author'),
          creationDate: getMetadataInfoDate(metadata?.info, 'CreationDate'),
          creator: getMetadataInfoValue(metadata?.info, 'Creator'),
          producer: getMetadataInfoValue(metadata?.info, 'Producer'),
        };
      } finally {
        await this.closePDFDocument(pdf);
      }
    } catch (error) {
      console.error('unpdf getInfo failed:', error);

      // Return minimal info with error handling
      return {
        pageCount: 0,
        encrypted: false,
        hasEmbeddedText: false,
        hasImages: false,
        recommendedStrategy: 'hybrid',
        ocrRequired: false,
        estimatedProcessingTime: {
          textExtraction: 'fast',
        },
      };
    }
  }
}
