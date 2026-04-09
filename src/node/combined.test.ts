import { describe, expect, it, vi } from 'vitest';
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
