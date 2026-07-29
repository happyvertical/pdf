import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPDFReader, getProviderInfo } from '../index';
import { CombinedNodeProvider } from './combined';
import { KreuzbergProvider } from './kreuzberg';
import { resetKreuzbergRuntimeCache } from './kreuzberg-runtime';

// Standing in for the native specifier so these tests can assert that provider
// selection never reaches it. Asserting the returned provider alone would not
// do: on a machine that has AVX2 — every dev box and CI runner — the broken
// code returned the same reader after surviving the probe.
const { loadNativeModule, detectAvx2Support } = vi.hoisted(() => ({
  loadNativeModule: vi.fn(),
  // Default to the failing host so the `initializeProviders()` warm-up that
  // runs when `../index` is first imported is covered by the guard too.
  detectAvx2Support: vi.fn(() => ({
    supported: false,
    reason: "this CPU does not advertise the 'avx2' flag in /proc/cpuinfo",
  })),
}));

vi.mock('@kreuzberg/node', () => {
  loadNativeModule();
  return {
    extractFile: vi.fn(),
    extractBytes: vi.fn(),
    listOcrBackends: () => ['tesseract'],
  };
});

vi.mock('./cpu-baseline', () => ({ detectAvx2Support }));

const PRE_AVX2_HOST = {
  supported: false,
  reason: "this CPU does not advertise the 'avx2' flag in /proc/cpuinfo",
};

const AVX2_HOST = {
  supported: true,
  reason: "this CPU advertises the 'avx2' flag in /proc/cpuinfo",
};

const COMBINED_UNAVAILABLE = {
  available: false,
  error: 'page rendering unavailable',
  details: {
    unpdf: true,
    pageRendering: false,
    ocr: true,
    ocrProviders: 1,
  },
};

// Deliberately no `vi.resetModules()` here. Resetting the registry would give
// the factory's dynamic `import('../node/combined.js')` a different class from
// the one spied on below, the spy would silently never apply, and every test
// in this file would pass whether or not the fix is present.
beforeEach(() => {
  vi.clearAllMocks();
  resetKreuzbergRuntimeCache();
  detectAvx2Support.mockReturnValue(PRE_AVX2_HOST);
});

describe('automatic provider selection on a pre-AVX2 CPU', () => {
  it('falls back to a working unpdf reader without importing the native module', async () => {
    // Force selection past the combined provider so the Kreuzberg branch is
    // genuinely reached; otherwise this passes on any machine, fix or no fix.
    const combinedDeps = vi
      .spyOn(CombinedNodeProvider.prototype, 'checkDependencies')
      .mockResolvedValueOnce(COMBINED_UNAVAILABLE);

    try {
      const reader = await getPDFReader({ provider: 'auto' });

      // Proves the branch under test was actually entered.
      expect(combinedDeps).toHaveBeenCalled();
      expect(reader.constructor.name).toBe('CombinedNodeProvider');
      await expect(reader.checkCapabilities()).resolves.toMatchObject({
        canExtractText: true,
      });
      expect(loadNativeModule).not.toHaveBeenCalled();
    } finally {
      combinedDeps.mockRestore();
    }
  });

  it('reports kreuzberg as unusable through getProviderInfo without importing it', async () => {
    // `initializeProviders()` runs this path on module load, so an unguarded
    // probe made importing the package fatal on its own.
    const info = await getProviderInfo('kreuzberg');

    expect(info.dependencies?.available).toBe(false);
    expect(info.dependencies?.error).toMatch(/AVX2/);
    expect(loadNativeModule).not.toHaveBeenCalled();
  });
});

describe('explicit kreuzberg selection on a pre-AVX2 CPU', () => {
  it('degrades like a missing dependency instead of terminating the process', async () => {
    // The crash was reachable here too, so pin what a caller who names the
    // provider actually observes: an ordinary unavailable-dependency result.
    const reader = await getPDFReader({ provider: 'kreuzberg' });

    await expect(reader.checkDependencies()).resolves.toMatchObject({
      available: false,
    });
    // skipOCRFallback keeps this off the tessdata setup path, which is
    // unrelated to what is being asserted.
    await expect(
      reader.extractText(Buffer.from('%PDF-1.7'), { skipOCRFallback: true }),
    ).resolves.toBeNull();
    expect(loadNativeModule).not.toHaveBeenCalled();
  });
});

describe('availability probing cost', () => {
  it('probes kreuzberg once per process instead of on every getPDFReader call', async () => {
    detectAvx2Support.mockReturnValue(AVX2_HOST);

    const combinedDeps = vi
      .spyOn(CombinedNodeProvider.prototype, 'checkDependencies')
      .mockResolvedValue(COMBINED_UNAVAILABLE);
    const kreuzbergDeps = vi
      .spyOn(KreuzbergProvider.prototype, 'checkDependencies')
      .mockResolvedValue({
        available: false,
        error: 'ocr backend unavailable',
        details: { kreuzberg: true },
      });

    try {
      // A language nothing else in this file uses, so these two calls share a
      // cache key with each other and with no other test.
      const options = {
        provider: 'auto' as const,
        defaultOCROptions: { language: 'deu' },
      };
      await getPDFReader(options);
      await getPDFReader(options);

      expect(combinedDeps).toHaveBeenCalled();
      expect(kreuzbergDeps).toHaveBeenCalledTimes(1);
    } finally {
      combinedDeps.mockRestore();
      kreuzbergDeps.mockRestore();
    }
  });
});

describe('automatic provider selection with OCR disabled', () => {
  it('never probes the OCR-capable native provider, even on a capable CPU', async () => {
    // The reported caller passed exactly this and was still killed probing a
    // provider it had just opted out of. Reporting a capable CPU here keeps the
    // test honest: the baseline guard cannot satisfy it, only the short-circuit.
    detectAvx2Support.mockReturnValue(AVX2_HOST);

    // Primed so that dropping the short-circuit would fall through to the
    // Kreuzberg branch and import the native module, failing this test.
    const combinedDeps = vi
      .spyOn(CombinedNodeProvider.prototype, 'checkDependencies')
      .mockResolvedValueOnce(COMBINED_UNAVAILABLE);

    try {
      const reader = await getPDFReader({
        enableOCR: false,
        // A distinct availability cache key from the case above, so a cached
        // answer cannot stand in for the short-circuit under test.
        ocrProvider: 'tesseract',
      });

      expect(reader.constructor.name).toBe('CombinedNodeProvider');
      // Disabling OCR settles the choice outright: neither provider is probed.
      expect(combinedDeps).not.toHaveBeenCalled();
      expect(loadNativeModule).not.toHaveBeenCalled();
    } finally {
      combinedDeps.mockRestore();
    }
  });
});
