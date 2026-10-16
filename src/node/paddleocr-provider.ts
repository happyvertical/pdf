/**
 * @happyvertical/pdf - PaddleOCR-VL as a full PDFReader backend
 *
 * Reading (text and OCR) goes to the remote PaddleOCR-VL pipeline. Operations
 * the service cannot answer (document metadata, embedded images, page rasters,
 * the structural probe behind getInfo) run locally through unpdf, so callers
 * see one complete reader. Selected only by name, never by `auto`.
 */

import { stat } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BasePDFReader } from '../shared/base';
import { canonicalizeImageFormat } from '../shared/image-format';
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
  RenderPagesOptions,
} from '../shared/types';
import { PDFError, PDFFileSizeError } from '../shared/types';
import { encodePDFImage } from './image-encoding';
import {
  PaddleOCRClient,
  type PaddleOCRClientOptions,
  PaddleOCRError,
} from './paddleocr';
import { UnpdfProvider } from './unpdf';

/** Options for `getPDFReader({ provider: 'paddleocr', paddleocr })`. */
export interface PaddleOCRReaderOptions extends PaddleOCRClientOptions {
  /**
   * Read locally only after every page has text and no raster image content.
   * Scanned or mixed documents still go to the service.
   * Default: `HAVE_PDF_PADDLEOCR_PREFER_EMBEDDED_TEXT=true`, else false — the
   * service reads every document.
   */
  preferEmbeddedText?: boolean;
  /**
   * `false` keeps every document local: text comes from the text layer only,
   * as with `skipOCRFallback`, and nothing is sent to the service. Mirrors the
   * reader's `enableOCR`. Default: true.
   */
  enableOCR?: boolean;
}

const ENCODED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

function imageBytes(data: PDFImage['data']): Uint8Array {
  if (typeof data === 'string') {
    // OCRImage strings are base64, optionally as a data URL.
    return Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  }
  return data;
}

/** Decode a WebP (which the service may not accept) and re-encode it as PNG. */
async function webpToPng(data: Uint8Array): Promise<Uint8Array> {
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(Buffer.from(data));
  } catch {
    throw new PDFError('WebP image could not be decoded', 'EINVAL');
  }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.encode('png');
}

/**
 * PDFReader backed by a PaddleOCR-VL `/layout-parsing` service.
 *
 * - `extractText`: the service's Markdown (tables as HTML), one parse per
 *   call; `pages` selects from the parsed pages.
 * - `performOCR`: each image is parsed as a one-page document, in order.
 * - `getInfo`, `extractMetadata`, `extractImages`, `renderPages`: local unpdf.
 *
 * A service failure is thrown as `PaddleOCRError`. There is no retry and no
 * fallback to a local OCR engine.
 */
export class PaddleOCRProvider extends BasePDFReader {
  protected name = 'paddleocr';
  private readonly client: PaddleOCRClient;
  private readonly local = new UnpdfProvider();
  private readonly preferEmbeddedText: boolean;
  private readonly enableOCR: boolean;
  private readonly maxFileSize: number;

  constructor(options: PaddleOCRReaderOptions = {}) {
    super();
    const { preferEmbeddedText, enableOCR, ...clientOptions } = options;
    // Validates baseUrl, timeout and size up front, so misconfiguration fails
    // when the reader is created rather than on the first document.
    this.client = new PaddleOCRClient(clientOptions);
    this.preferEmbeddedText =
      preferEmbeddedText ??
      process.env.HAVE_PDF_PADDLEOCR_PREFER_EMBEDDED_TEXT === 'true';
    this.enableOCR = enableOCR ?? true;
    this.maxFileSize = clientOptions.maxFileSize ?? 50 * 1024 * 1024;
  }

  async extractText(
    source: PDFSource,
    options?: ExtractTextOptions,
  ): Promise<string | null> {
    await this.assertSourceSize(source);
    if (options?.skipOCRFallback || !this.enableOCR) {
      return this.local.extractText(source, options);
    }
    const info = await this.local.getInfo(source);
    if (
      this.preferEmbeddedText &&
      info.recommendedStrategy === 'text' &&
      (await this.local.hasCompleteTextLayer(source))
    ) {
      return this.local.extractText(source, options);
    }

    const result = await this.client.parse(source);
    // A pageCount of 0 means unpdf could not open the document (damaged or
    // encrypted); the service may still read it, so there is nothing to check.
    if (info.pageCount > 0 && result.pages.length !== info.pageCount) {
      // A service that capped or merged pages must not pass for blank pages.
      throw new PaddleOCRError(
        `PaddleOCR returned ${result.pages.length} pages for a ${info.pageCount}-page document`,
        'EPADDLERESPONSE',
      );
    }
    const pages = this.normalizePages(options?.pages, result.pages.length);
    const text = this.mergePageTexts(
      pages.map((page) => result.pages[page - 1].markdown),
      options?.mergePages,
    );
    return text.trim() ? text : null;
  }

  async performOCR(
    images: PDFImage[],
    _options?: OCROptions,
  ): Promise<OCRResult> {
    const started = Date.now();
    const texts: string[] = [];
    for (const image of images) {
      let data = imageBytes(image.data);
      if (canonicalizeImageFormat(image.format) === 'image/webp') {
        // extractImages() emits WebP by default.
        data = await webpToPng(data);
      } else if (!ENCODED_IMAGE_TYPES.has(image.format ?? '')) {
        // Raw pixel buffers are encoded first; already-encoded PNG or JPEG
        // bytes pass through unchanged.
        const encoded = await encodePDFImage({ ...image, data }, 'png');
        if (!ENCODED_IMAGE_TYPES.has(encoded.format ?? '')) {
          throw new PDFError(
            'PaddleOCR needs PNG or JPEG images, or raw pixels with dimensions',
            'EINVAL',
          );
        }
        data = imageBytes(encoded.data);
      }
      const result = await this.client.parseImage(data);
      texts.push(result.markdown);
    }

    const text = texts.join('\n\n');
    return {
      text,
      // The service reports no score; follow the package's other model-backed
      // providers and report full confidence for any text.
      confidence: text.trim() ? 100 : 0,
      metadata: {
        provider: 'paddleocr',
        processingTime: Date.now() - started,
      },
    };
  }

  async getInfo(source: PDFSource): Promise<PDFInfo> {
    await this.assertSourceSize(source);
    return this.local.getInfo(source);
  }

  async extractMetadata(source: PDFSource): Promise<PDFMetadata> {
    await this.assertSourceSize(source);
    return this.local.extractMetadata(source);
  }

  async extractImages(
    source: PDFSource,
    options?: ExtractImagesOptions,
  ): Promise<PDFImage[]> {
    await this.assertSourceSize(source);
    return this.local.extractImages(source, options);
  }

  async renderPages(
    source: PDFSource,
    options?: RenderPagesOptions,
  ): Promise<PDFImage[]> {
    await this.assertSourceSize(source);
    return this.local.renderPages(source, options);
  }

  private async assertSourceSize(source: PDFSource): Promise<void> {
    try {
      const size =
        typeof source === 'string'
          ? (await stat(source)).size
          : source.byteLength;
      if (size > this.maxFileSize)
        throw new PDFFileSizeError(size, this.maxFileSize);
    } catch (error) {
      if (error instanceof PDFError) throw error;
      throw new PaddleOCRError(
        'PaddleOCR input could not be inspected',
        'EPADDLEIO',
      );
    }
  }

  async checkCapabilities(): Promise<PDFCapabilities> {
    const local = await this.local.checkCapabilities();
    return {
      canExtractText: true,
      canExtractMetadata: local.canExtractMetadata,
      canExtractImages: local.canExtractImages,
      canPerformOCR: true,
      supportedFormats: ['pdf'],
      maxFileSize: this.maxFileSize,
      ocrLanguages: undefined,
    };
  }

  /**
   * Configuration and the local half only. The service is not probed: a proxy
   * `/health` success does not mean the model is loaded.
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    const local = await this.local.checkDependencies();
    return {
      ...local,
      details: { ...local.details, paddleocr: true },
    };
  }
}
