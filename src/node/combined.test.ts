import { describe, expect, it, vi } from 'vitest';
import { PDFBatchExtractionError, PDFFileSizeError } from '../shared/types';
import { CombinedNodeProvider } from './combined';
import { UnpdfProvider } from './unpdf';

describe('CombinedNodeProvider', () => {
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
});
