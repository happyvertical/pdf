/**
 * @happyvertical/pdf - CPU instruction-set baseline detection for native modules
 *
 * Some optional native dependencies are compiled above the host's
 * microarchitecture baseline. `optionalDependencies` cannot express that: npm
 * and pnpm only skip a package by `os`, `cpu`, or `libc`, and AVX2 is a
 * microarchitecture level rather than an architecture. Such a module therefore
 * installs and resolves normally on any x86-64 Linux host, and then executes an
 * illegal instruction the moment its prebuilt binary runs on a pre-AVX2 CPU.
 *
 * `SIGILL` is a signal, not a JavaScript exception, so a `try`/`catch` around
 * the call cannot contain it — the process is already gone. The only safe way
 * to answer "can this module be used?" is to check the capability *before*
 * loading or calling it.
 */

import { readFileSync } from 'node:fs';

/** Path Linux uses to expose per-core CPU capability flags. */
const CPUINFO_PATH = '/proc/cpuinfo';

/**
 * Host facts a baseline probe needs, isolated so tests can describe a machine
 * they are not running on.
 */
export interface CpuBaselineEnvironment {
  /** Node platform identifier, as in `process.platform`. */
  platform: string;
  /** Node architecture identifier, as in `process.arch`. */
  arch: string;
  /** Raw `/proc/cpuinfo` contents, or null when it cannot be read. */
  readCpuInfo: () => string | null;
}

/**
 * Outcome of a CPU feature probe.
 *
 * `reason` is always populated — including on success — so callers can put a
 * specific explanation into a dependency error instead of a bare boolean.
 */
export interface CpuFeatureSupport {
  /** Whether the feature is known to be usable on this host. */
  supported: boolean;
  /** Human-readable explanation of how the verdict was reached. */
  reason: string;
}

/**
 * Build the default environment describing the machine this process runs on.
 *
 * @returns Environment reading real platform, architecture, and CPU flags
 */
export function createCpuBaselineEnvironment(): CpuBaselineEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    readCpuInfo: () => {
      try {
        // Synchronous by design: this runs on the provider-selection path and
        // /proc/cpuinfo is a small in-memory file, so a spawn or an async hop
        // would cost more than the read.
        return readFileSync(CPUINFO_PATH, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Collect the CPU capability flags advertised in `/proc/cpuinfo`.
 *
 * Flags are tokenized rather than substring-matched so that a lookup for
 * `avx2` cannot be satisfied by an unrelated longer flag name.
 */
function parseCpuFlags(cpuInfo: string): Set<string> {
  const flags = new Set<string>();

  for (const line of cpuInfo.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    // x86 kernels label the list `flags`; some architectures use `Features`.
    const key = line.slice(0, separator).trim();
    if (key !== 'flags' && key !== 'Features') {
      continue;
    }

    const values = line.slice(separator + 1).trim();
    for (const flag of values.split(/\s+/)) {
      if (flag) {
        flags.add(flag);
      }
    }
  }

  return flags;
}

/**
 * Determine whether this host can execute AVX2 instructions.
 *
 * Used to decide whether an AVX2-compiled native module may be imported at
 * all. Because a wrong "yes" costs the whole process, an x86-64 Linux host
 * whose flags cannot be read is reported as unsupported: callers then fall
 * back to a pure-JavaScript provider instead of risking a fatal signal.
 *
 * @param environment - Host facts to probe; defaults to the current machine
 * @returns Support verdict together with the reason behind it
 *
 * @example
 * ```typescript
 * const avx2 = detectAvx2Support();
 * if (!avx2.supported) {
 *   console.warn(`Skipping native provider: ${avx2.reason}`);
 * }
 * ```
 */
export function detectAvx2Support(
  environment: CpuBaselineEnvironment = createCpuBaselineEnvironment(),
): CpuFeatureSupport {
  if (environment.arch !== 'x64') {
    // AVX2 is an x86-64 extension. Everywhere else the question does not
    // apply, and native builds carry their own architecture baseline.
    return {
      supported: true,
      reason: `architecture '${environment.arch}' does not use AVX2`,
    };
  }

  if (environment.platform !== 'linux') {
    // Only Linux publishes CPU flags cheaply and synchronously. Assume macOS
    // and Windows x86-64 hosts are capable: the fault has only ever been seen
    // on old Linux server CPUs, and guessing "unsupported" here would silently
    // disable native providers on every modern developer machine.
    return {
      supported: true,
      reason: `CPU flags are not readable on platform '${environment.platform}'`,
    };
  }

  const cpuInfo = environment.readCpuInfo();
  if (cpuInfo === null) {
    return {
      supported: false,
      reason: `${CPUINFO_PATH} could not be read, so the AVX2 baseline of this x86-64 host is unverified`,
    };
  }

  if (!parseCpuFlags(cpuInfo).has('avx2')) {
    return {
      supported: false,
      reason: `this CPU does not advertise the 'avx2' flag in ${CPUINFO_PATH}`,
    };
  }

  return {
    supported: true,
    reason: `this CPU advertises the 'avx2' flag in ${CPUINFO_PATH}`,
  };
}
