import { describe, expect, it, vi } from 'vitest';
import {
  type CpuBaselineEnvironment,
  createCpuBaselineEnvironment,
  detectAvx2Support,
} from './cpu-baseline';

const AVX2_CPUINFO = [
  'processor\t: 0',
  'model name\t: Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz',
  'flags\t\t: fpu vme de pse tsc msr pae sse sse2 avx avx2 bmi2 rdseed',
  '',
].join('\n');

// A Westmere Xeon X5650: SSE4.2 era, no AVX at all. This is the shape of the
// CI machine that the import probe was killing.
const PRE_AVX2_CPUINFO = [
  'processor\t: 0',
  'model name\t: Intel(R) Xeon(R) CPU X5650 @ 2.67GHz',
  'flags\t\t: fpu vme de pse tsc msr pae sse sse2 ssse3 sse4_1 sse4_2 popcnt',
  '',
].join('\n');

function linuxHost(cpuInfo: string | null): CpuBaselineEnvironment {
  return {
    platform: 'linux',
    arch: 'x64',
    readCpuInfo: () => cpuInfo,
  };
}

describe('detectAvx2Support', () => {
  it('reports support when the CPU advertises the avx2 flag', () => {
    expect(detectAvx2Support(linuxHost(AVX2_CPUINFO))).toMatchObject({
      supported: true,
    });
  });

  it('reports no support on an x86-64 CPU without the avx2 flag', () => {
    const support = detectAvx2Support(linuxHost(PRE_AVX2_CPUINFO));

    expect(support.supported).toBe(false);
    expect(support.reason).toContain('avx2');
  });

  it('matches whole flags so a longer flag name cannot satisfy the check', () => {
    const avx512Only = linuxHost(
      'flags\t\t: fpu sse2 avx avx512f avx512dq avx2_not_a_real_flag\n',
    );

    expect(detectAvx2Support(avx512Only).supported).toBe(false);
  });

  it('fails closed when /proc/cpuinfo cannot be read', () => {
    // The baseline is then unknown, and guessing wrong costs the whole
    // process rather than one caught error.
    const support = detectAvx2Support(linuxHost(null));

    expect(support.supported).toBe(false);
    expect(support.reason).toContain('/proc/cpuinfo');
  });

  it('does not disable native modules on non-x86 architectures', () => {
    const appleSilicon: CpuBaselineEnvironment = {
      platform: 'darwin',
      arch: 'arm64',
      readCpuInfo: vi.fn(() => null),
    };

    expect(detectAvx2Support(appleSilicon).supported).toBe(true);
    expect(appleSilicon.readCpuInfo).not.toHaveBeenCalled();
  });

  it('does not disable native modules on x86-64 platforms without /proc', () => {
    const windows: CpuBaselineEnvironment = {
      platform: 'win32',
      arch: 'x64',
      readCpuInfo: vi.fn(() => null),
    };

    expect(detectAvx2Support(windows).supported).toBe(true);
    expect(windows.readCpuInfo).not.toHaveBeenCalled();
  });
});

describe('createCpuBaselineEnvironment', () => {
  it('describes the host this process is running on', () => {
    const environment = createCpuBaselineEnvironment();

    expect(environment.platform).toBe(process.platform);
    expect(environment.arch).toBe(process.arch);
  });

  it('returns null instead of throwing when /proc/cpuinfo is absent', () => {
    // Passes on macOS and Windows (no /proc) and on Linux (readable file).
    expect(() => createCpuBaselineEnvironment().readCpuInfo()).not.toThrow();
  });
});
