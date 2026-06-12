/**
 * @happyvertical/pdf - HTML to PDF rendering.
 *
 * Generation counterpart to the extraction providers: renders an HTML string
 * to PDF bytes using a system Chromium via `puppeteer-core`. Faithful CSS
 * (fonts, print styles, `@page` rules) needs a real browser engine, so the
 * engine choice is encapsulated here — consumers depend on this package, not
 * on a browser automation library.
 *
 * Deliberate constraints:
 * - `puppeteer-core`, not `puppeteer`: no browser download on install and no
 *   config-file loader (`cosmiconfig`) in the dependency graph. The wrapper's
 *   cosmiconfig chain declares an optional `typescript` peer that bundlers
 *   happily inline (~12 MB) and that crashes ESM builds at module load via
 *   `ts.sys`'s `__filename` probe — the exact failure this module exists to
 *   make impossible for consumers.
 * - The engine is imported lazily inside `renderHtmlToPdf`, so importing
 *   `@happyvertical/pdf` never pulls browser automation code until a caller
 *   actually renders. Same idiom as the `@napi-rs/canvas` encoder in
 *   `encodePDFImage`.
 * - Callers provide the Chromium binary (container image, system install, or
 *   `PUPPETEER_EXECUTABLE_PATH`). `resolveChromiumExecutablePath` probes the
 *   common locations; we never download browsers at runtime.
 */

import { access } from 'node:fs/promises';

/** Paper sizes accepted by Chromium's print-to-PDF. */
export type HtmlToPdfFormat =
  | 'Letter'
  | 'Legal'
  | 'Tabloid'
  | 'Ledger'
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6';

/** CSS-style page margins, e.g. `{ top: '0.55in' }`. */
export interface HtmlToPdfMargin {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}

export interface HtmlToPdfOptions {
  /**
   * Chromium/Chrome binary to launch. Defaults to
   * `resolveChromiumExecutablePath()`; rendering throws a descriptive error
   * when no binary can be found.
   */
  executablePath?: string;
  /** Paper format. Ignored when the document's CSS `@page` size wins via `preferCSSPageSize`. */
  format?: HtmlToPdfFormat;
  landscape?: boolean;
  margin?: HtmlToPdfMargin;
  /** Render CSS backgrounds. Defaults to true — print-accurate output. */
  printBackground?: boolean;
  /** Let a CSS `@page` size declared in the document override `format`. Defaults to true. */
  preferCSSPageSize?: boolean;
  /** Page scale factor, 0.1–2. */
  scale?: number;
  /**
   * Wait for `document.fonts.ready` before printing so web fonts don't render
   * as fallbacks. Defaults to true.
   */
  waitForFonts?: boolean;
  /** Browser launch timeout in milliseconds. Defaults to 60_000. */
  launchTimeoutMs?: number;
  /**
   * Extra Chromium launch args. Appended to the container-safe defaults
   * (`--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`).
   */
  extraLaunchArgs?: string[];
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Container-safe launch defaults. Sandboxing is unavailable in most container
 * runtimes without extra privileges, and /dev/shm is typically too small for
 * Chromium's default shared memory usage.
 */
const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

/** Well-known Chromium/Chrome install locations, probed in order. */
const CHROMIUM_PROBE_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
];

/**
 * Locate a usable Chromium/Chrome binary.
 *
 * Honors `PUPPETEER_EXECUTABLE_PATH` first, then probes well-known install
 * locations. Returns `undefined` when nothing is found so callers can decide
 * whether that is fatal (`renderHtmlToPdf` treats it as fatal).
 */
export async function resolveChromiumExecutablePath(): Promise<
  string | undefined
> {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;

  for (const path of CHROMIUM_PROBE_PATHS) {
    try {
      await access(path);
      return path;
    } catch {
      // Probe the next well-known location.
    }
  }

  return undefined;
}

/**
 * Render an HTML document to PDF bytes.
 *
 * Launches Chromium, loads the HTML, waits for fonts (by default), and prints
 * with print-accurate defaults (backgrounds on, CSS `@page` size respected).
 * The browser always closes, including on failure.
 *
 * @example
 * ```typescript
 * import { renderHtmlToPdf } from '@happyvertical/pdf';
 *
 * const pdf = await renderHtmlToPdf('<h1>Hello</h1>', {
 *   format: 'Letter',
 *   margin: { top: '0.5in', bottom: '0.5in' },
 * });
 * await writeFile('hello.pdf', pdf);
 * ```
 */
export async function renderHtmlToPdf(
  html: string,
  options: HtmlToPdfOptions = {},
): Promise<Uint8Array> {
  const executablePath =
    options.executablePath ?? (await resolveChromiumExecutablePath());
  if (!executablePath) {
    throw new Error(
      'renderHtmlToPdf: no Chromium/Chrome binary found. Install chromium in ' +
        'the runtime image (e.g. `apt-get install chromium`) or set ' +
        'PUPPETEER_EXECUTABLE_PATH / options.executablePath.',
    );
  }

  // Lazy: browser automation enters the process only when a caller renders.
  const { launch } = await import('puppeteer-core');

  const browser = await launch({
    executablePath,
    args: [...DEFAULT_LAUNCH_ARGS, ...(options.extraLaunchArgs ?? [])],
    timeout: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    if (options.waitForFonts !== false) {
      await page.evaluateHandle('document.fonts.ready');
    }
    return await page.pdf({
      format: options.format,
      landscape: options.landscape,
      margin: options.margin,
      preferCSSPageSize: options.preferCSSPageSize !== false,
      printBackground: options.printBackground !== false,
      scale: options.scale,
    });
  } finally {
    await browser.close();
  }
}
