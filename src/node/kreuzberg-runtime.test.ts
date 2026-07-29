import { beforeEach, describe, expect, it, vi } from 'vitest';

// Reaching the native binary at all is the fatal act: it is dlopen'd on first
// use and raises SIGILL on a pre-AVX2 CPU, which is a signal and therefore
// uncatchable and unrecoverable. Standing in for the specifier lets these tests
// assert the contract that actually matters — that the module is never reached
// — instead of asserting a return value a modern CPU would produce either way.
const { loadNativeModule, detectAvx2Support } = vi.hoisted(() => ({
  loadNativeModule: vi.fn(),
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

// Re-imported per test rather than bound statically, so the module-level caches
// and the `@kreuzberg/node` registry entry start fresh each time. Without that,
// a module cached by an earlier test would make a later "never imported"
// assertion pass for the wrong reason.
async function importRuntime() {
  return import('./kreuzberg-runtime');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  detectAvx2Support.mockReturnValue(PRE_AVX2_HOST);
});

describe('kreuzberg runtime guard', () => {
  it('reports the module as unloadable without importing it on a pre-AVX2 CPU', async () => {
    const { isKreuzbergModuleLoadable } = await importRuntime();

    await expect(isKreuzbergModuleLoadable()).resolves.toBe(false);
    expect(loadNativeModule).not.toHaveBeenCalled();
  });

  it('rejects an explicit load with a catchable error instead of a signal', async () => {
    const { loadKreuzbergModule } = await importRuntime();

    // Matched structurally rather than with `instanceof`: resetting the module
    // registry per test gives the reloaded graph its own error classes.
    await expect(loadKreuzbergModule()).rejects.toMatchObject({
      name: 'PDFDependencyError',
      code: 'EDEP',
    });
    await expect(loadKreuzbergModule()).rejects.toThrow(/AVX2/);
    expect(loadNativeModule).not.toHaveBeenCalled();
  });

  it('checks the CPU once per process rather than on every call', async () => {
    // Driven through `loadKreuzbergModule`, which consults the baseline on
    // every call — so this pins the baseline memoization specifically rather
    // than passing on any one of several caches short-circuiting first.
    const { loadKreuzbergModule } = await importRuntime();

    await expect(loadKreuzbergModule()).rejects.toThrow();
    await expect(loadKreuzbergModule()).rejects.toThrow();
    await expect(loadKreuzbergModule()).rejects.toThrow();

    expect(detectAvx2Support).toHaveBeenCalledTimes(1);
  });

  it('loads the module when the CPU meets the baseline', async () => {
    detectAvx2Support.mockReturnValue(AVX2_HOST);

    const { isKreuzbergModuleLoadable, loadKreuzbergModule } =
      await importRuntime();

    await expect(isKreuzbergModuleLoadable()).resolves.toBe(true);
    // Resolving to the stand-in module is itself the proof that the import
    // happened. Asserting on the mock factory's call count instead would be
    // order-dependent: vitest runs that factory once per file, not per test.
    await expect(loadKreuzbergModule()).resolves.toHaveProperty('extractFile');
  });
});
