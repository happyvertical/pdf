import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDFBatchExtractionError,
  PDFFileSizeError,
  PDFImageCollectionLimitError,
  PDFOCRFallbackError,
} from '../shared/types';
import { DISABLE_CHILD_EXTRACTION_ENV } from './child-extraction';
import { CombinedNodeProvider } from './combined';
import { UnpdfProvider } from './unpdf';

describe('CombinedNodeProvider', () => {
  const originalChildExtractionEnv = process.env[DISABLE_CHILD_EXTRACTION_ENV];

  beforeEach(() => {
    process.env[DISABLE_CHILD_EXTRACTION_ENV] = '1';
  });

  afterEach(() => {
    if (originalChildExtractionEnv === undefined) {
      delete process.env[DISABLE_CHILD_EXTRACTION_ENV];
    } else {
      process.env[DISABLE_CHILD_EXTRACTION_ENV] = originalChildExtractionEnv;
    }
  });

  it('should report unavailable when unpdf dependencies are missing', async () => {
    const reader = new CombinedNodeProvider() as any;

    reader.unpdfProvider = {
      checkDependencies: vi.fn().mockResolvedValue({
        available: false,
        error: 'page rendering unavailable: worker mismatch',
        details: {
          unpdf: true,
          pageRendering: false,
        },
      }),
    };
    reader.ocrFactory = {
      isOCRAvailable: vi.fn().mockResolvedValue(true),
      getProvidersInfo: vi.fn().mockResolvedValue([{ provider: 'onnx' }]),
    };

    await expect(reader.checkDependencies()).resolves.toMatchObject({
      available: false,
      error: 'page rendering unavailable: worker mismatch',
      details: {
        unpdf: true,
        pageRendering: false,
        ocr: true,
        ocrProviders: 1,
      },
    });
  });

  it('batches large text-based PDFs and preserves batch order when pages are merged', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(40 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 60,
      fileSize: 40 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: true,
      hasImages: false,
      recommendedStrategy: 'text',
      ocrRequired: false,
      estimatedProcessingTime: {
        textExtraction: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi.fn().mockImplementation(async (_source, options) => {
        const pages = options?.pages ?? [];
        return `[${pages[0]}-${pages[pages.length - 1]}]`;
      }),
    };

    const text = await reader.extractText('/tmp/large.pdf', {
      mergePages: true,
    });

    expect(text).toBe('[1-25] [26-50] [51-60]');
    expect(reader.unpdfProvider.extractText).toHaveBeenCalledTimes(3);
    expect(reader.unpdfProvider.extractText).toHaveBeenNthCalledWith(
      1,
      '/tmp/large.pdf',
      expect.objectContaining({
        pages: Array.from({ length: 25 }, (_, index) => index + 1),
        mergePages: true,
        skipOCRFallback: true,
      }),
    );
  });

  it('preserves per-page boundaries for large text PDFs when mergePages is false', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(40 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 4,
      fileSize: 40 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: true,
      hasImages: false,
      recommendedStrategy: 'text',
      ocrRequired: false,
      estimatedProcessingTime: {
        textExtraction: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi.fn().mockImplementation(async (_source, options) => {
        const page = options?.pages?.[0];
        return `page-${page}`;
      }),
    };

    const text = await reader.extractText('/tmp/large.pdf', {
      mergePages: false,
    });

    expect(text).toBe('page-1\n\npage-2\n\npage-3\n\npage-4');
    expect(reader.unpdfProvider.extractText).toHaveBeenCalledTimes(4);
    expect(reader.unpdfProvider.extractText).toHaveBeenNthCalledWith(
      1,
      '/tmp/large.pdf',
      expect.objectContaining({
        pages: [1],
        mergePages: true,
        skipOCRFallback: true,
      }),
    );
  });

  it('preserves per-page boundaries by default for large text PDFs', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(40 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 3,
      fileSize: 40 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: true,
      hasImages: false,
      recommendedStrategy: 'text',
      ocrRequired: false,
      estimatedProcessingTime: {
        textExtraction: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi.fn().mockImplementation(async (_source, options) => {
        const page = options?.pages?.[0];
        return `page-${page}`;
      }),
    };

    const text = await reader.extractText('/tmp/large.pdf');

    expect(text).toBe('page-1\n\npage-2\n\npage-3');
    expect(reader.unpdfProvider.extractText).toHaveBeenCalledTimes(3);
  });

  it('batches OCR extraction for large image-based PDFs', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(30 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 9,
      fileSize: 30 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: false,
      hasImages: true,
      recommendedStrategy: 'ocr',
      ocrRequired: true,
      estimatedProcessingTime: {
        textExtraction: 'slow',
        ocrProcessing: 'slow',
      },
    });

    reader.unpdfProvider = {
      renderPages: vi.fn().mockImplementation(async (_source, options) => {
        return (options?.pages ?? []).map((pageNumber: number) => ({
          data: Buffer.from([pageNumber]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber,
        }));
      }),
    };
    reader.ocrFactory = {
      performOCR: vi
        .fn()
        .mockImplementation(async (images: Array<{ pageNumber?: number }>) => ({
          text: `ocr:${images.map((image) => image.pageNumber).join(',')}`,
          confidence: 99,
        })),
    };

    const text = await reader.extractText('/tmp/scanned.pdf', {
      mergePages: true,
    });

    expect(text).toBe('ocr:1,2,3,4 ocr:5,6,7,8 ocr:9');
    expect(reader.unpdfProvider.renderPages).toHaveBeenCalledTimes(3);
    expect(reader.ocrFactory.performOCR).toHaveBeenCalledTimes(3);
  });

  it('continues large OCR extraction when one batch has no recognized text', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(30 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 5,
      fileSize: 30 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: false,
      hasImages: true,
      recommendedStrategy: 'ocr',
      ocrRequired: true,
      estimatedProcessingTime: {
        textExtraction: 'slow',
        ocrProcessing: 'slow',
      },
    });

    reader.unpdfProvider = {
      renderPages: vi.fn().mockImplementation(async (_source, options) => {
        return (options?.pages ?? []).map((pageNumber: number) => ({
          data: Buffer.from([pageNumber]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber,
        }));
      }),
    };
    reader.ocrFactory = {
      performOCR: vi
        .fn()
        .mockResolvedValueOnce({
          text: '',
          confidence: 0,
        })
        .mockResolvedValueOnce({
          text: 'ocr:5',
          confidence: 99,
        }),
    };

    await expect(
      reader.extractText('/tmp/scanned.pdf', { mergePages: true }),
    ).resolves.toBe('ocr:5');
    expect(reader.unpdfProvider.renderPages).toHaveBeenCalledTimes(2);
    expect(reader.ocrFactory.performOCR).toHaveBeenCalledTimes(2);
  });

  it('throws an explicit OCR fallback error when every OCR batch is empty', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(30 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 5,
      fileSize: 30 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: false,
      hasImages: true,
      recommendedStrategy: 'ocr',
      ocrRequired: true,
      estimatedProcessingTime: {
        textExtraction: 'slow',
        ocrProcessing: 'slow',
      },
    });

    reader.unpdfProvider = {
      renderPages: vi.fn().mockImplementation(async (_source, options) => {
        return (options?.pages ?? []).map((pageNumber: number) => ({
          data: Buffer.from([pageNumber]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber,
        }));
      }),
    };
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: '',
        confidence: 0,
      }),
    };

    await expect(
      reader.extractText('/tmp/scanned.pdf', { mergePages: true }),
    ).rejects.toBeInstanceOf(PDFOCRFallbackError);
    await expect(
      reader.extractText('/tmp/scanned.pdf', { mergePages: true }),
    ).rejects.toThrow('OCR fallback produced no text for pages 1-5.');
  });

  it('applies default OCR options during automatic OCR fallback', async () => {
    const reader = new CombinedNodeProvider({
      defaultOCROptions: {
        language: 'fra',
        confidenceThreshold: 72,
      },
    }) as any;

    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue(''),
      getInfo: vi.fn().mockResolvedValue({ pageCount: 1 }),
      renderPages: vi.fn().mockResolvedValue([
        {
          data: Buffer.from([1]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber: 1,
        },
      ]),
    };
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: 'bonjour',
        confidence: 95,
      }),
    };

    await expect(reader.extractText('/tmp/scanned.pdf')).resolves.toBe(
      'bonjour',
    );
    expect(reader.ocrFactory.performOCR).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        language: 'fra',
        confidenceThreshold: 72,
      }),
    );
  });

  it('renders automatic OCR fallback pages as PNG images', async () => {
    const reader = new CombinedNodeProvider() as any;

    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue(''),
      getInfo: vi.fn().mockResolvedValue({ pageCount: 1 }),
      renderPages: vi.fn().mockResolvedValue([
        {
          data: Buffer.from([1]),
          format: 'image/png',
          width: 10,
          height: 10,
          pageNumber: 1,
        },
      ]),
    };
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: 'recognized text',
        confidence: 95,
      }),
    };

    await expect(reader.extractText('/tmp/scanned.pdf')).resolves.toBe(
      'recognized text',
    );
    expect(reader.unpdfProvider.renderPages).toHaveBeenCalledWith(
      '/tmp/scanned.pdf',
      expect.objectContaining({
        outputFormat: 'png',
        scale: 2,
        throwOnError: true,
      }),
    );
  });

  it('throws an explicit OCR fallback error when rendered OCR returns no text', async () => {
    const reader = new CombinedNodeProvider() as any;

    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue(''),
      getInfo: vi.fn().mockResolvedValue({ pageCount: 1 }),
      renderPages: vi.fn().mockResolvedValue([
        {
          data: Buffer.from([1]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber: 1,
        },
      ]),
    };
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: '',
        confidence: 0,
        detections: [],
        metadata: {
          provider: 'onnx',
        },
      }),
    };

    await expect(reader.extractText('/tmp/scanned.pdf')).rejects.toBeInstanceOf(
      PDFOCRFallbackError,
    );
    await expect(reader.extractText('/tmp/scanned.pdf')).rejects.toThrow(
      'OCR fallback produced no text for all pages. Provider: onnx. Confidence: 0.0. Detections: 0.',
    );
    expect(reader.unpdfProvider.renderPages).toHaveBeenCalledWith(
      '/tmp/scanned.pdf',
      expect.objectContaining({
        scale: 2,
        throwOnError: true,
      }),
    );
  });

  it.each([
    { pages: [] as number[], label: 'empty' },
    { pages: [99], label: 'out-of-range' },
  ])(
    'returns null for $label OCR fallback pages without rendering',
    async ({ pages }) => {
      const reader = new CombinedNodeProvider() as any;

      reader.unpdfProvider = {
        extractText: vi.fn().mockResolvedValue(''),
        getInfo: vi.fn().mockResolvedValue({ pageCount: 2 }),
        renderPages: vi.fn(),
      };
      reader.ocrFactory = {
        performOCR: vi.fn(),
      };

      await expect(
        reader.extractText('/tmp/scanned.pdf', { pages }),
      ).resolves.toBeNull();
      expect(reader.unpdfProvider.renderPages).not.toHaveBeenCalled();
      expect(reader.ocrFactory.performOCR).not.toHaveBeenCalled();
    },
  );

  it('surfaces OCR fallback rendering failures instead of returning null', async () => {
    const reader = new CombinedNodeProvider() as any;

    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue(''),
      getInfo: vi.fn().mockResolvedValue({ pageCount: 1 }),
      renderPages: vi.fn().mockRejectedValue(new Error('canvas unavailable')),
    };
    reader.ocrFactory = {
      performOCR: vi.fn(),
    };

    await expect(reader.extractText('/tmp/scanned.pdf')).rejects.toBeInstanceOf(
      PDFOCRFallbackError,
    );
    await expect(reader.extractText('/tmp/scanned.pdf')).rejects.toThrow(
      'OCR fallback failed for all pages: canvas unavailable',
    );
    expect(reader.ocrFactory.performOCR).not.toHaveBeenCalled();
  });

  it('merges explicit OCR options over configured defaults', async () => {
    const reader = new CombinedNodeProvider({
      defaultOCROptions: {
        language: 'fra',
        confidenceThreshold: 72,
      },
    }) as any;
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: 'bonjour',
        confidence: 95,
      }),
    };

    await reader.performOCR(
      [
        {
          data: Buffer.from([1]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
        },
      ],
      {
        language: 'eng',
      },
    );

    expect(reader.ocrFactory.performOCR).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        language: 'eng',
        confidenceThreshold: 72,
      }),
    );
  });

  it('respects skipOCRFallback for large OCR-recommended PDFs', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(32 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 8,
      fileSize: 32 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: false,
      hasImages: true,
      recommendedStrategy: 'ocr',
      ocrRequired: true,
      estimatedProcessingTime: {
        textExtraction: 'slow',
        ocrProcessing: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi.fn().mockImplementation(async (_source, options) => {
        const pages = options?.pages ?? [];
        return `direct:${pages[0]}-${pages[pages.length - 1]}`;
      }),
    };
    reader.ocrFactory = {
      performOCR: vi.fn(),
    };

    const text = await reader.extractText('/tmp/scanned.pdf', {
      mergePages: true,
      skipOCRFallback: true,
    });

    expect(text).toBe('direct:1-8');
    expect(reader.ocrFactory.performOCR).not.toHaveBeenCalled();
    expect(reader.unpdfProvider.extractText).toHaveBeenCalledOnce();
  });

  it('falls back to OCR for sparse hybrid batches', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(32 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 8,
      fileSize: 32 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: true,
      hasImages: true,
      recommendedStrategy: 'hybrid',
      ocrRequired: false,
      estimatedProcessingTime: {
        textExtraction: 'slow',
        ocrProcessing: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi.fn().mockImplementation(async (_source, options) => {
        const firstPage = options?.pages?.[0];
        return firstPage === 1
          ? 'brief'
          : 'This batch already has enough direct text to avoid OCR fallback. '.repeat(
              5,
            );
      }),
      renderPages: vi.fn().mockImplementation(async (_source, options) => {
        return (options?.pages ?? []).map((pageNumber: number) => ({
          data: Buffer.from([pageNumber]),
          format: 'rgb',
          width: 10,
          height: 10,
          channels: 3,
          pageNumber,
        }));
      }),
    };
    reader.ocrFactory = {
      performOCR: vi.fn().mockResolvedValue({
        text: 'ocr rescued batch',
        confidence: 98,
      }),
    };

    const text = await reader.extractText('/tmp/hybrid.pdf', {
      mergePages: true,
    });

    expect(text).toBe(
      `ocr rescued batch ${'This batch already has enough direct text to avoid OCR fallback. '.repeat(5).trim()}`,
    );
    expect(reader.ocrFactory.performOCR).toHaveBeenCalledTimes(1);
  });

  it('throws on mid-batch failures instead of returning partial text', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(40 * 1024 * 1024);

    reader.getInfo = vi.fn().mockResolvedValue({
      pageCount: 60,
      fileSize: 40 * 1024 * 1024,
      encrypted: false,
      hasEmbeddedText: true,
      hasImages: false,
      recommendedStrategy: 'text',
      ocrRequired: false,
      estimatedProcessingTime: {
        textExtraction: 'slow',
      },
    });

    reader.unpdfProvider = {
      extractText: vi
        .fn()
        .mockResolvedValueOnce('first batch')
        .mockRejectedValueOnce(new Error('page parse failed')),
    };

    const extractionPromise = reader.extractText('/tmp/broken.pdf', {
      mergePages: true,
    });

    await expect(extractionPromise).rejects.toBeInstanceOf(
      PDFBatchExtractionError,
    );
    await expect(extractionPromise).rejects.toThrow(
      'Large PDF extraction failed for pages 26-50: page parse failed',
    );
  });

  it('throws configured maxFileSize before analyzing oversized inputs', async () => {
    const reader = new CombinedNodeProvider({ maxFileSize: 4 }) as any;
    reader.getInfo = vi.fn();

    await expect(
      reader.extractText(new Uint8Array([1, 2, 3, 4, 5])),
    ).rejects.toBeInstanceOf(PDFFileSizeError);
    expect(reader.getInfo).not.toHaveBeenCalled();
  });

  it('offloads large extractions without blocking the parent heartbeat loop', async () => {
    delete process.env[DISABLE_CHILD_EXTRACTION_ENV];

    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(25 * 1024 * 1024);
    reader.getInfo = vi.fn();
    reader.childExtractText = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('child text'), 20);
        }),
    );

    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      heartbeatTicks += 1;
    }, 1);

    try {
      await expect(reader.extractText('/tmp/large.pdf')).resolves.toBe(
        'child text',
      );
    } finally {
      clearInterval(heartbeat);
    }

    expect(heartbeatTicks).toBeGreaterThan(0);
    expect(reader.childExtractText).toHaveBeenCalledWith(
      '/tmp/large.pdf',
      undefined,
    );
    expect(reader.getInfo).not.toHaveBeenCalled();
  });

  it('propagates child extraction failures instead of falling back to partial local work', async () => {
    delete process.env[DISABLE_CHILD_EXTRACTION_ENV];

    const reader = new CombinedNodeProvider() as any;
    reader.getSourceByteLength = vi.fn().mockResolvedValue(25 * 1024 * 1024);
    reader.childExtractText = vi
      .fn()
      .mockRejectedValue(new Error('child extraction failed'));
    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue('local text'),
    };

    await expect(reader.extractText('/tmp/large.pdf')).rejects.toThrow(
      'child extraction failed',
    );
    expect(reader.unpdfProvider.extractText).not.toHaveBeenCalled();
  });

  it('skips expensive getInfo for small inputs without paging hints', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.getInfo = vi.fn();
    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue('direct text'),
    };

    await expect(
      reader.extractText(new Uint8Array([1, 2, 3, 4])),
    ).resolves.toBe('direct text');
    expect(reader.getInfo).not.toHaveBeenCalled();
  });

  it('accepts ArrayBuffer sources in the direct extraction path', async () => {
    const reader = new CombinedNodeProvider() as any;
    reader.unpdfProvider = {
      extractText: vi.fn().mockResolvedValue('array-buffer-text'),
    };

    await expect(
      reader.extractText(new Uint8Array([1, 2, 3, 4]).buffer),
    ).resolves.toBe('array-buffer-text');
  });

  it('reports configured maxFileSize through capabilities', async () => {
    const reader = new CombinedNodeProvider({
      maxFileSize: 64 * 1024 * 1024,
    }) as any;

    reader.unpdfProvider = {
      checkCapabilities: vi.fn().mockResolvedValue({
        canExtractText: true,
        canExtractMetadata: true,
        canExtractImages: true,
        canPerformOCR: false,
        supportedFormats: ['pdf'],
        maxFileSize: undefined,
      }),
    };
    reader.ocrFactory = {
      isOCRAvailable: vi.fn().mockResolvedValue(true),
      getSupportedLanguages: vi.fn().mockResolvedValue(['eng']),
    };

    await expect(reader.checkCapabilities()).resolves.toMatchObject({
      maxFileSize: 64 * 1024 * 1024,
      ocrLanguages: ['eng'],
    });
  });

  it('reports the lower provider maxFileSize when it is stricter than the configured ceiling', async () => {
    const reader = new CombinedNodeProvider({
      maxFileSize: 64 * 1024 * 1024,
    }) as any;

    reader.unpdfProvider = {
      checkCapabilities: vi.fn().mockResolvedValue({
        canExtractText: true,
        canExtractMetadata: true,
        canExtractImages: true,
        canPerformOCR: false,
        supportedFormats: ['pdf'],
        maxFileSize: 16 * 1024 * 1024,
      }),
    };
    reader.ocrFactory = {
      isOCRAvailable: vi.fn().mockResolvedValue(false),
      getSupportedLanguages: vi.fn(),
    };

    await expect(reader.checkCapabilities()).resolves.toMatchObject({
      maxFileSize: 16 * 1024 * 1024,
    });
  });
});

describe('UnpdfProvider', () => {
  it('configures unpdf to use the official pdfjs-dist legacy runtime', async () => {
    const reader = new UnpdfProvider() as any;

    reader.ensurePdfjsWorkerConfigured = vi.fn().mockResolvedValue(undefined);

    const definePDFJSModule = vi
      .fn()
      .mockImplementation(async (resolver: () => Promise<unknown>) => {
        const resolved = await resolver();
        const expected = await import('pdfjs-dist/legacy/build/pdf.mjs');

        expect(resolved).toBe(expected);
      });

    await reader.ensureUnpdfPdfjsRuntime({ definePDFJSModule });
    await reader.ensureUnpdfPdfjsRuntime({ definePDFJSModule });

    expect(definePDFJSModule).toHaveBeenCalledTimes(1);
    expect(reader.ensurePdfjsWorkerConfigured).not.toHaveBeenCalled();
  });

  it('resolves pdfjs asset directories as filesystem paths for Node rendering flows', () => {
    const reader = new UnpdfProvider() as any;

    const options = reader.getPdfjsDocumentOptions(true);

    expect(options).toMatchObject({
      useWorkerFetch: false,
      standardFontDataUrl: expect.stringMatching(/\/$/),
      wasmUrl: expect.stringMatching(/\/$/),
    });
    expect(options.standardFontDataUrl).not.toMatch(/^file:\/\//);
    expect(options.wasmUrl).not.toMatch(/^file:\/\//);
  });

  it('tolerates missing optional pdfjs asset bundles', () => {
    const reader = new UnpdfProvider() as any;

    vi.spyOn(reader, 'resolveOptionalPdfjsAssetDirectory')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce('/tmp/pdfjs-wasm/');

    expect(reader.getPdfjsDocumentOptions(true)).toEqual({
      useWorkerFetch: false,
      wasmUrl: '/tmp/pdfjs-wasm/',
    });
  });

  it('should surface page rendering dependency failures', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({});
    reader.verifyRenderDependencies = vi
      .fn()
      .mockRejectedValue(new Error('worker mismatch'));

    await expect(reader.checkDependencies()).resolves.toMatchObject({
      available: false,
      error: 'page rendering unavailable: worker mismatch',
      details: {
        unpdf: true,
        pageRendering: false,
      },
    });
  });

  it('streams image batches without retaining previous batch images', async () => {
    const reader = new UnpdfProvider() as any;
    const documents: Array<{
      cleanup: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const getDocumentProxy = vi.fn().mockImplementation(async () => {
      const document = {
        numPages: 5,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      };
      documents.push(document);
      return document;
    });

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy,
      extractImages: vi.fn().mockImplementation(async (_pdf, pageNumber) => [
        {
          data: Buffer.alloc(1024 * 1024, pageNumber),
          width: 1,
          height: 1024 * 1024,
          channels: 1,
        },
      ]),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const seenBatches: number[][] = [];
    const result = await reader.extractImages('/tmp/large.pdf', {
      batchSize: 2,
      // This test exercises batch streaming + cleanup; pin to raw output so
      // mocked byte buffers flow through unchanged (webp encoding would
      // turn the 1MB raw buffers into compressed payloads).
      outputFormat: 'original',
      onBatch: async ({ images, pages, batchIndex, totalBatches }) => {
        seenBatches.push(pages);
        expect(images.map((image) => image.pageNumber)).toEqual(pages);
        expect(batchIndex).toBe(seenBatches.length - 1);
        expect(totalBatches).toBe(3);
      },
    });

    expect(result).toEqual([]);
    expect(seenBatches).toEqual([[1, 2], [3, 4], [5]]);
    expect(getDocumentProxy).toHaveBeenCalledTimes(4);
    expect(getDocumentProxy.mock.calls[0]?.[1]).toEqual({
      useWorkerFetch: false,
    });
    for (const [, options] of getDocumentProxy.mock.calls.slice(1)) {
      expect(options).toMatchObject({
        useWorkerFetch: false,
        standardFontDataUrl: expect.stringMatching(/\/$/),
        wasmUrl: expect.stringMatching(/\/$/),
      });
      expect(options.standardFontDataUrl).not.toMatch(/^file:\/\//);
      expect(options.wasmUrl).not.toMatch(/^file:\/\//);
    }
    for (const document of documents) {
      expect(document.cleanup).toHaveBeenCalledOnce();
      expect(document.destroy).toHaveBeenCalledOnce();
    }
  });

  it('rejects collected image extraction before retaining unbounded image bytes', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 3,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi.fn().mockImplementation(async (_pdf, pageNumber) => [
        {
          data: Buffer.alloc(6, pageNumber),
          width: 1,
          height: 6,
          channels: 1,
        },
      ]),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    await expect(
      reader.extractImages('/tmp/large.pdf', {
        batchSize: 1,
        maxCollectedBytes: 10,
      }),
    ).rejects.toBeInstanceOf(PDFImageCollectionLimitError);
  });

  it('allows streaming image extraction without collection even when batches exceed the collection limit', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 2,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi.fn().mockImplementation(async (_pdf, pageNumber) => [
        {
          data: Buffer.alloc(12, pageNumber),
          width: 1,
          height: 12,
          channels: 1,
        },
      ]),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const seenPages: number[] = [];
    const images = await reader.extractImages('/tmp/large.pdf', {
      batchSize: 1,
      maxCollectedBytes: 0,
      onBatch: ({ pages }) => {
        seenPages.push(...pages);
      },
    });

    expect(images).toEqual([]);
    expect(seenPages).toEqual([1, 2]);
  });

  it('passes file-backed getInfo sources through without forcing an extra buffer clone', async () => {
    const reader = new UnpdfProvider() as any;
    const unpdf = {};
    const pdf = {
      numPages: 1,
      getMetadata: vi.fn().mockResolvedValue({ info: {} }),
      getPage: vi.fn().mockResolvedValue({
        getTextContent: vi.fn().mockResolvedValue({ items: [] }),
        getOperatorList: vi.fn().mockResolvedValue({ fnArray: [] }),
      }),
      cleanup: vi.fn(),
      destroy: vi.fn(),
    };

    reader.loadUnpdf = vi.fn().mockResolvedValue(unpdf);
    reader.loadPDFDocument = vi.fn().mockResolvedValue(pdf);
    reader.getSourceFileSize = vi.fn().mockResolvedValue(1234);

    await expect(reader.getInfo('/tmp/document.pdf')).resolves.toMatchObject({
      fileSize: 1234,
      pageCount: 1,
    });

    expect(reader.loadPDFDocument).toHaveBeenCalledWith(
      unpdf,
      '/tmp/document.pdf',
    );
    expect(reader.getSourceFileSize).toHaveBeenCalledWith('/tmp/document.pdf');
    expect(pdf.cleanup).toHaveBeenCalledOnce();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it('returns an empty list for zero-length byte sources', async () => {
    const reader = new UnpdfProvider() as any;
    reader.loadUnpdf = vi.fn();

    await expect(reader.extractImages(new Uint8Array())).resolves.toEqual([]);
    expect(reader.loadUnpdf).not.toHaveBeenCalled();
  });

  it('does not reject non-empty ArrayBuffer render sources as invalid input', async () => {
    const reader = new UnpdfProvider() as any;
    reader.ensurePdfjsWorkerConfigured = vi.fn().mockResolvedValue(undefined);

    await expect(
      reader.renderPages(new Uint8Array([1, 2, 3, 4, 5]).buffer, {
        throwOnError: true,
      }),
    ).rejects.toBeInstanceOf(PDFOCRFallbackError);
    expect(reader.ensurePdfjsWorkerConfigured).toHaveBeenCalledOnce();
  });

  it('preserves page and image order across collected image batches', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 5,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi
        .fn()
        .mockImplementation(async (_pdf, pageNumber: number) => [
          {
            data: Buffer.from([pageNumber, 1]),
            width: 1,
            height: 2,
            channels: 1,
          },
          {
            data: Buffer.from([pageNumber, 2]),
            width: 1,
            height: 2,
            channels: 1,
          },
        ]),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const images = await reader.extractImages('/tmp/document.pdf', {
      pages: [2, 4, 5],
      batchSize: 2,
      // This test asserts on the raw mocked bytes, so pin to 'original'.
      // Encoding is covered separately in image-encoding.test.ts.
      outputFormat: 'original',
    });

    expect(images.map((image) => image.pageNumber)).toEqual([2, 2, 4, 4, 5, 5]);
    expect(images.map((image) => [...image.data])).toEqual([
      [2, 1],
      [2, 2],
      [4, 1],
      [4, 2],
      [5, 1],
      [5, 2],
    ]);
  });

  it('rejects explicit page decode failures during image batching', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 4,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi
        .fn()
        .mockImplementation(async (_pdf, pageNumber: number) => {
          if (pageNumber === 3) {
            throw new Error('decode failed');
          }

          return [
            {
              data: Buffer.from([pageNumber]),
              width: 1,
              height: 1,
              channels: 1,
            },
          ];
        }),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const extractionPromise = reader.extractImages('/tmp/broken.pdf', {
      batchSize: 2,
    });

    await expect(extractionPromise).rejects.toBeInstanceOf(
      PDFBatchExtractionError,
    );
    await expect(extractionPromise).rejects.toThrow(
      'Large PDF extraction failed for pages 3: decode failed',
    );
  });

  it('preserves caller onBatch failures without remapping them', async () => {
    const reader = new UnpdfProvider() as any;

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 2,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi.fn().mockResolvedValue([
        {
          data: Buffer.from([1]),
          width: 1,
          height: 1,
          channels: 1,
        },
      ]),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const batchError = new Error('storage write failed');

    await expect(
      reader.extractImages('/tmp/document.pdf', {
        batchSize: 1,
        onBatch: async () => {
          throw batchError;
        },
      }),
    ).rejects.toBe(batchError);
  });

  it('sniffs encoded JPEG/PNG streams instead of mislabelling them as raw RGB (issue #74 review)', async () => {
    // Codex / Copilot review on PR #75: when the upstream returns a
    // 3-channel image whose bytes are an encoded JPEG/PNG stream (byte
    // length does not match width*height*channels), we must not label it
    // image/x-rgb just because channels === 3.
    const reader = new UnpdfProvider() as any;
    const jpegPayload = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    ]);
    const pngPayload = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const rawRgbPayload = Buffer.alloc(2 * 2 * 3, 200); // 2x2 RGB
    const opaqueGarbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    reader.loadUnpdf = vi.fn().mockResolvedValue({
      getDocumentProxy: vi.fn().mockResolvedValue({
        numPages: 4,
        cleanup: vi.fn(),
        destroy: vi.fn(),
      }),
      extractImages: vi
        .fn()
        .mockImplementation(async (_pdf, pageNumber: number) => {
          if (pageNumber === 1) {
            return [
              { data: jpegPayload, width: 100, height: 100, channels: 3 },
            ];
          }
          if (pageNumber === 2) {
            return [{ data: pngPayload, width: 100, height: 100, channels: 4 }];
          }
          if (pageNumber === 3) {
            return [{ data: rawRgbPayload, width: 2, height: 2, channels: 3 }];
          }
          return [{ data: opaqueGarbage, width: 99, height: 99, channels: 3 }];
        }),
    });
    reader.normalizeSource = vi
      .fn()
      .mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    reader.validatePDFData = vi.fn().mockReturnValue(true);

    const images = await reader.extractImages('/tmp/document.pdf', {
      pages: [1, 2, 3, 4],
      batchSize: 4,
      // Pin to 'original' so we observe the format inferred by the
      // extractor, not the encoding output's mime.
      outputFormat: 'original',
    });

    expect(images.map((image: any) => image.format)).toEqual([
      'image/jpeg', // sniffed from FF D8 FF — not labelled image/x-rgb
      'image/png', // sniffed from PNG signature — not labelled image/x-rgba
      'image/x-rgb', // byte length matches raw layout
      'application/octet-stream', // no signature, no raw layout
    ]);
    // Encoded streams should not carry bitsPerComponent (they're not raw).
    expect(images[0].bitsPerComponent).toBeUndefined();
    expect(images[1].bitsPerComponent).toBeUndefined();
    expect(images[3].bitsPerComponent).toBeUndefined();
    // Raw layout still carries bps so consumers can decode unambiguously.
    expect(images[2].bitsPerComponent).toBe(8);
  });
});
