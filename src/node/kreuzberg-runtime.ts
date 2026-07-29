/**
 * @happyvertical/pdf - Guarded loader for the optional @kreuzberg/node native module
 *
 * This module owns the only `import('@kreuzberg/node')` in the package. Every
 * caller — the provider itself and the availability probe used by automatic
 * provider selection — goes through {@link loadKreuzbergModule}, so the CPU
 * baseline is verified exactly once and always before the native binary is
 * reachable.
 *
 * The prebuilt binary emits unguarded AVX2. It is `dlopen`'d lazily on first
 * use rather than at import, so on a pre-AVX2 (x86-64-v2) host the illegal
 * instruction fires on the first native call — which an availability probe
 * makes immediately. `SIGILL` is a signal rather than a JavaScript exception,
 * so it kills the process outright: no `try`/`catch` can contain it and no
 * fallback can run.
 *
 * The invariant that keeps the process alive is therefore that the module is
 * never *loaded or called* without passing the baseline check, not merely that
 * it is never imported. Guarding the single entry point below is what enforces
 * it, and it turns "fatally unavailable" back into "unavailable".
 */

import { PDFDependencyError } from '../shared/types';
import { type CpuFeatureSupport, detectAvx2Support } from './cpu-baseline';

/** Extraction configuration accepted by `@kreuzberg/node`. */
export type KreuzbergExtractionConfig = {
  ocr?: {
    backend: string;
    language?: string;
    tesseractConfig?: {
      enableTableDetection?: boolean;
    };
  };
};

/** Extraction result returned by `@kreuzberg/node`. */
export type KreuzbergResult = {
  content?: string | null;
  metadata?: Record<string, unknown>;
};

/** Subset of the `@kreuzberg/node` surface this package depends on. */
export type KreuzbergModule = {
  extractFile(
    filePath: string,
    mimeType?: string | null,
    config?: KreuzbergExtractionConfig | null,
  ): Promise<KreuzbergResult>;
  extractBytes(
    data: Buffer,
    mimeType: string,
    config?: KreuzbergExtractionConfig | null,
  ): Promise<KreuzbergResult>;
  listOcrBackends?: () => string[];
};

let cachedBaseline: CpuFeatureSupport | null = null;
let cachedModule: Promise<KreuzbergModule> | null = null;

function getBaseline(): CpuFeatureSupport {
  if (!cachedBaseline) {
    cachedBaseline = detectAvx2Support();
  }

  return cachedBaseline;
}

/**
 * Load `@kreuzberg/node`, refusing to import it on an incompatible CPU.
 *
 * Resolves to the cached module on repeat calls. When the host cannot execute
 * the instructions the binary was built with, this throws a normal, catchable
 * error and the native module is never touched.
 *
 * @returns The loaded native module
 *
 * @throws {PDFDependencyError} When the CPU baseline is unmet or the module
 * cannot be imported
 *
 * @example
 * ```typescript
 * try {
 *   const kreuzberg = await loadKreuzbergModule();
 *   await kreuzberg.extractFile('/path/to/document.pdf');
 * } catch (error) {
 *   // Reached on a pre-AVX2 host instead of the process dying by signal.
 *   console.warn('kreuzberg unavailable:', (error as Error).message);
 * }
 * ```
 */
export async function loadKreuzbergModule(): Promise<KreuzbergModule> {
  const baseline = getBaseline();
  if (!baseline.supported) {
    throw new PDFDependencyError(
      '@kreuzberg/node',
      `the prebuilt binary requires AVX2 and ${baseline.reason}. Use provider: 'unpdf' on this host.`,
    );
  }

  if (!cachedModule) {
    cachedModule = import('@kreuzberg/node') as Promise<KreuzbergModule>;
  }

  return cachedModule;
}

/**
 * Report whether `@kreuzberg/node` can be loaded on this host.
 *
 * Safe to call on the default provider-selection path: it never lets an
 * incompatible native binary run, and the answer is computed once per process
 * rather than on every `getPDFReader()` call.
 *
 * @returns True when the module was imported successfully
 *
 * @example
 * ```typescript
 * if (await isKreuzbergModuleLoadable()) {
 *   // Safe to construct the Kreuzberg provider.
 * }
 * ```
 */
export async function isKreuzbergModuleLoadable(): Promise<boolean> {
  // No cache of its own: the baseline verdict and the module handle behind
  // `loadKreuzbergModule()` are both already memoized, so repeat calls are
  // cheap and there is no third piece of state to keep consistent.
  return loadKreuzbergModule().then(
    () => true,
    () => false,
  );
}

/**
 * Discard the cached baseline verdict and module handle.
 *
 * @internal Exposed for tests that need to probe more than one simulated host.
 */
export function resetKreuzbergRuntimeCache(): void {
  cachedBaseline = null;
  cachedModule = null;
}
