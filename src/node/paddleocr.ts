import { readFile, stat } from 'node:fs/promises';
import { PDFError, PDFFileSizeError, type PDFSource } from '../shared/types';

/** Connection settings for a full PaddleOCR-VL parsing service (not a VLM endpoint). */
export interface PaddleOCRClientOptions {
  /** Service root, e.g. http://paddleocr-vl. Falls back to HAVE_PDF_PADDLEOCR_URL. */
  baseUrl?: string;
  /** Optional bearer token for deployments with an authentication proxy. */
  apiKey?: string;
  /** Whole operation deadline including cold start and response body. Default: 65 minutes. */
  timeout?: number;
  /** Maximum PDF input bytes. Default: 50 MiB. */
  maxFileSize?: number;
}

/** Per-document options. Full layout detection remains enabled. */
export interface PaddleOCRParseOptions {
  /** Cancel reading, submission, or response consumption. */
  signal?: AbortSignal;
  /** Return inline image data referenced by Markdown. Default: false. */
  returnMarkdownImages?: boolean;
}

/** One actual PDF page, in source order. Unknown layout fields are preserved. */
export interface PaddleOCRPage {
  /** One-based source page number. */
  pageNumber: number;
  /** Markdown for this page. */
  markdown: string;
  /** Upstream structured layout, including blocks and coordinates when available. */
  layout: Record<string, unknown>;
  /** Optional Markdown image paths mapped to base64 content or upstream URLs. */
  images?: Record<string, string>;
}

/** Full-document parsing result, with both Markdown and structured page data. */
export interface PaddleOCRResult {
  /** Page Markdown joined with blank lines, preserving page order. */
  markdown: string;
  pages: PaddleOCRPage[];
  /** Upstream request identifier, when supplied. */
  logId?: string;
  /** Upstream input metadata, when supplied. */
  dataInfo?: Record<string, unknown>;
}

/** A transport or response-contract failure from the remote parser. */
export class PaddleOCRError extends PDFError {
  constructor(
    message: string,
    code: string,
    /** HTTP response status, when a response was received. */
    public status?: number,
  ) {
    super(message, code);
    this.name = 'PaddleOCRError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new PaddleOCRError(
    'Invalid PaddleOCR parsing response',
    'EPADDLERESPONSE',
  );
}

function normalizeResponse(value: unknown): PaddleOCRResult {
  if (!record(value) || typeof value.errorCode !== 'number') invalidResponse();
  if (value.errorCode !== 0) {
    // Do not echo upstream errors: they can contain document text or credentials.
    throw new PaddleOCRError(
      'PaddleOCR reported a parsing failure',
      'EPADDLEAPI',
    );
  }
  if (!record(value.result)) invalidResponse();
  const result = value.result;
  if (!Array.isArray(result.layoutParsingResults)) invalidResponse();
  const pages = result.layoutParsingResults.map((page, index) => {
    if (
      !record(page) ||
      !record(page.markdown) ||
      typeof page.markdown.text !== 'string' ||
      !record(page.prunedResult)
    )
      invalidResponse();
    const images = page.markdown.images;
    if (
      images != null &&
      (!record(images) ||
        Object.values(images).some((v) => typeof v !== 'string'))
    ) {
      invalidResponse();
    }
    return {
      pageNumber: index + 1,
      markdown: page.markdown.text,
      layout: page.prunedResult,
      ...(images != null ? { images: images as Record<string, string> } : {}),
    };
  });
  if (value.logId !== undefined && typeof value.logId !== 'string')
    invalidResponse();
  if (result.dataInfo !== undefined && !record(result.dataInfo))
    invalidResponse();
  return {
    markdown: pages.map((page) => page.markdown).join('\n\n'),
    pages,
    ...(typeof value.logId === 'string' ? { logId: value.logId } : {}),
    ...(record(result.dataInfo) ? { dataInfo: result.dataInfo } : {}),
  };
}

/**
 * Explicit Node.js client for the full PaddleOCR-VL HTTP pipeline.
 *
 * Sends PDF bytes to /layout-parsing. Strings are local paths, never remote URLs.
 * It does not change getPDFReader defaults or implement an image OCR provider.
 * Requests are not retried automatically: a failed connection can leave a GPU
 * parse running. A /health response from an on-demand proxy is not model readiness.
 */
export class PaddleOCRClient {
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly maxFileSize: number;

  constructor(options: PaddleOCRClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.HAVE_PDF_PADDLEOCR_URL;
    if (!baseUrl) {
      throw new PDFError(
        'Set baseUrl or HAVE_PDF_PADDLEOCR_URL for PaddleOCR',
        'EINVAL',
      );
    }
    try {
      const url = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('Invalid service URL');
      }
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/layout-parsing`;
      this.endpoint = url;
    } catch {
      throw new PDFError(
        'PaddleOCR baseUrl must be an HTTP(S) service root without credentials, query or fragment',
        'EINVAL',
      );
    }
    this.apiKey = options.apiKey ?? process.env.HAVE_PDF_PADDLEOCR_API_KEY;
    this.timeout = options.timeout ?? 65 * 60 * 1000;
    this.maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
    if (
      !Number.isInteger(this.timeout) ||
      this.timeout <= 0 ||
      this.timeout > 2_147_483_647
    ) {
      throw new PDFError(
        'PaddleOCR timeout must be a positive integer up to 2147483647 milliseconds',
        'EINVAL',
      );
    }
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize <= 0) {
      throw new PDFError(
        'PaddleOCR maxFileSize must be a positive safe integer',
        'EINVAL',
      );
    }
  }

  /** Parse a complete local PDF; preserves page layout and Markdown in the result. */
  async parse(
    source: PDFSource,
    options: PaddleOCRParseOptions = {},
  ): Promise<PaddleOCRResult> {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeout);
    timer.unref();
    try {
      signal.throwIfAborted();
      let data: Uint8Array;
      if (typeof source === 'string') {
        const info = await stat(source);
        this.assertSize(info.size);
        data = await readFile(source, { signal });
      } else if (source instanceof Uint8Array) {
        data = source;
      } else if (source instanceof ArrayBuffer) {
        data = new Uint8Array(source);
      } else {
        throw new PDFError(
          'Expected a PDF path, ArrayBuffer or Uint8Array',
          'EINVAL',
        );
      }
      this.assertSize(data.byteLength);
      if (
        data.length < 5 ||
        Buffer.from(data.subarray(0, 5)).toString('ascii') !== '%PDF-'
      ) {
        throw new PDFError('Invalid PDF header', 'EINVAL');
      }
      signal.throwIfAborted();
      const response = await fetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          file: Buffer.from(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ).toString('base64'),
          fileType: 0,
          useLayoutDetection: true,
          visualize: false,
          returnMarkdownImages: options.returnMarkdownImages ?? false,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new PaddleOCRError(
          `PaddleOCR HTTP request failed (${response.status})`,
          'EPADDLEHTTP',
          response.status,
        );
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (signal.aborted) signal.throwIfAborted();
        invalidResponse();
      }
      signal.throwIfAborted();
      return normalizeResponse(value);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new PaddleOCRError('PaddleOCR request cancelled', 'EABORT');
      }
      if (controller.signal.aborted) {
        throw new PaddleOCRError('PaddleOCR request timed out', 'ETIMEDOUT');
      }
      if (error instanceof PDFError) throw error;
      // Paths, server responses and fetch causes may contain private data.
      throw new PaddleOCRError(
        'PaddleOCR input or network operation failed',
        'EPADDLEIO',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private assertSize(size: number): void {
    if (size > this.maxFileSize)
      throw new PDFFileSizeError(size, this.maxFileSize);
  }
}
