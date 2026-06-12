import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHtmlToPdf, resolveChromiumExecutablePath } from './index';

const chromium = await resolveChromiumExecutablePath();

describe('HTML to PDF rendering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a chromium executable path or undefined', async () => {
    const path = await resolveChromiumExecutablePath();
    expect(path === undefined || typeof path === 'string').toBe(true);
  });

  it('ignores a stale PUPPETEER_EXECUTABLE_PATH instead of returning it', async () => {
    vi.stubEnv('PUPPETEER_EXECUTABLE_PATH', '/nonexistent/chromium-binary');
    const path = await resolveChromiumExecutablePath();
    // Falls back to probing well-known locations; never reports the bogus path.
    expect(path).not.toBe('/nonexistent/chromium-binary');
  });

  it('fails with a launch error when the executable path is bogus', async () => {
    await expect(
      renderHtmlToPdf('<p>hi</p>', {
        executablePath: '/nonexistent/chromium-binary',
      }),
    ).rejects.toThrow(/Browser was not found|Failed to launch|ENOENT/);
  });

  // Render tests need a real Chromium; skip cleanly where none is installed
  // (mirrors how OCR tests tolerate missing system dependencies).
  describe.skipIf(!chromium)('with a system chromium', () => {
    it('renders HTML to a valid PDF document', async () => {
      const pdf = await renderHtmlToPdf(
        '<html><body><h1>HTML to PDF</h1><p>render test</p></body></html>',
        { format: 'Letter' },
      );

      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(1000);
      // %PDF- magic bytes
      expect(Array.from(pdf.subarray(0, 5))).toEqual([
        0x25, 0x50, 0x44, 0x46, 0x2d,
      ]);
    });

    it('honors margins and page format options', async () => {
      const pdf = await renderHtmlToPdf('<p>margins</p>', {
        format: 'A4',
        margin: {
          top: '0.55in',
          bottom: '0.55in',
          left: '0.6in',
          right: '0.6in',
        },
        printBackground: true,
      });
      expect(pdf.length).toBeGreaterThan(1000);
    });
  });
});
