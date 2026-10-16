# @happyvertical/pdf

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Node.js PDF utilities for extracting text, reading metadata, extracting or
rendering images, running OCR fallback, and generating PDFs from Markdown or
HTML.

## Features

- Direct PDF text, metadata, and image extraction through `unpdf`
- OCR fallback for scanned or image-based PDFs through `@happyvertical/ocr`
- Document analysis with `getInfo()` strategy recommendations
- Batched image extraction for large PDFs
- Web-safe image output from extracted PDF images (`webp` by default)
- Markdown-to-PDF generation with `pdf-lib` and `marked`
- HTML-to-PDF generation with `puppeteer-core` and a system Chromium
- Typed errors for dependency, file-size, image-collection, and OCR failures

## Requirements

- Node.js `>=24`
- ESM imports
- A Chromium or Chrome binary only when using `renderHtmlToPdf`
- Extra memory for OCR-heavy workloads; 2 GB+ is a practical starting point

This package is currently Node-first. Browser provider code exists internally,
but the public package export does not expose a stable browser entry point yet.

## Installation

```bash
pnpm add @happyvertical/pdf
npm install @happyvertical/pdf
yarn add @happyvertical/pdf
bun add @happyvertical/pdf
```

Releases are published to the organisation registry, `https://npm.happyvertical.com/`
(which proxies npmjs for reads), and mirrored to npmjs on a best-effort basis.
Map the scope to it in your project `.npmrc` to install from the primary:

```ini
@happyvertical:registry=https://npm.happyvertical.com/
```

## Basic Usage

```typescript
import { getPDFReader } from '@happyvertical/pdf';

const reader = await getPDFReader();
const text = await reader.extractText('/path/to/document.pdf');

console.log(text);
```

`extractText()` first tries embedded PDF text. When OCR is enabled and direct
text extraction finds nothing useful, the Node reader renders pages and sends
them through `@happyvertical/ocr`.

## Analyze Before Processing

Use `getInfo()` when routing many documents or deciding whether OCR is likely
to be needed.

```typescript
import { getPDFReader } from '@happyvertical/pdf';

const reader = await getPDFReader();
const info = await reader.getInfo('/path/to/document.pdf');

console.log({
  pages: info.pageCount,
  hasEmbeddedText: info.hasEmbeddedText,
  hasImages: info.hasImages,
  strategy: info.recommendedStrategy,
});

const text = await reader.extractText('/path/to/document.pdf', {
  skipOCRFallback: info.recommendedStrategy === 'text',
});
```

## Metadata And Images

```typescript
import { getPDFReader } from '@happyvertical/pdf';

const reader = await getPDFReader();

const metadata = await reader.extractMetadata('/path/to/document.pdf');
console.log(metadata.title, metadata.author, metadata.pageCount);

const images = await reader.extractImages('/path/to/document.pdf');
console.log(images.map((image) => image.format)); // image/webp by default
```

`extractImages()` returns WebP images by default so callers can store or serve
`image.data` directly. Pass `outputFormat: 'original'` when you need the raw
provider bytes, especially for OCR pipelines that prefer raw RGB data.

```typescript
const rawImages = await reader.extractImages('/path/to/document.pdf', {
  outputFormat: 'original',
});
```

For image-heavy PDFs, process image batches incrementally instead of retaining
every image buffer in memory.

```typescript
await reader.extractImages('/path/to/large-document.pdf', {
  batchSize: 4,
  collect: false,
  onBatch: async ({ images, pages }) => {
    console.log(`Processing ${images.length} images from pages ${pages.join(', ')}`);
  },
});
```

## Explicit OCR

For scanned PDFs, prefer `extractText()` with OCR fallback. If you need to call
OCR yourself, render full pages rather than extracting embedded images.

```typescript
import { getPDFReader } from '@happyvertical/pdf';

const reader = await getPDFReader({
  defaultOCROptions: {
    language: 'eng',
    confidenceThreshold: 70,
  },
});

const pages = await reader.renderPages('/path/to/scanned.pdf', {
  scale: 2,
  outputFormat: 'original',
});

const result = await reader.performOCR(pages);
console.log(result.text, result.confidence);
```

## Generate PDFs

### Markdown

`renderMarkdownToPdf()` is pure JavaScript. It supports common Markdown blocks
and inline emphasis, uses PDF standard fonts, and paginates content.

```typescript
import { writeFile } from 'node:fs/promises';
import { renderMarkdownToPdf } from '@happyvertical/pdf';

const pdf = await renderMarkdownToPdf('# Status\n\nEverything is green.', {
  title: 'Status Report',
  pageSize: 'letter',
});

await writeFile('status.pdf', pdf);
```

### Images

`imagesToPdf()` puts one image on each page, in the order given, with `pdf-lib`
only: no browser, no network, and nothing written to disk. It returns the PDF
bytes. Inputs are `Buffer`, `Uint8Array`, or a file path.

```typescript
import { writeFile } from 'node:fs/promises';
import { imagesToPdf } from '@happyvertical/pdf';

const pdf = await imagesToPdf(['page-1.jpg', page2Buffer], {
  pageSize: 'letter',
  fit: 'contain',
  margin: 36,
  title: 'Mill certificate',
  creationDate: new Date('2026-10-04T00:00:00Z'), // same inputs + date = same bytes
});

await writeFile('cert.pdf', pdf);
```

- Types: PNG (including alpha) and JPEG, detected by file signature, never by
  file name or MIME type. JPEG EXIF orientation 1-8 is applied, so a phone
  photo comes out upright. **WebP is not supported** and throws
  `PDFImageUnsupportedTypeError`: `@napi-rs/canvas` can spin forever decoding a
  damaged WebP, so untrusted WebP is never handed to it. Convert it first.
- `pageSize`: `'image'` (default; the page is the image at `dpi`), `'letter'`,
  `'legal'`, `'a3'`, `'a4'`, `'a5'`, or `{ width, height }` in points.
  `orientation: 'auto'` (default) picks portrait or landscape per image for
  named and explicit sizes; `'portrait'` / `'landscape'` force one.
- `fit`: `'contain'` (default) shows the whole image; `'cover'` fills the area
  inside the margin and crops to it. `margin` is points on every side
  (default 0; in `'image'` mode it is added around the image). `dpi` default 150.
- `title` and `creationDate` set the document metadata. Without `creationDate`
  the current time is used, so output is not byte-stable.
- Limits (inputs are untrusted): `maxImages` 100, `maxImageBytes` 25 MiB,
  `maxTotalBytes` 256 MiB, `maxImagePixels` 50 million. Exceeding one throws
  `PDFImageLimitExceededError` (`limit`, `actual`, `max`, `index`). A truncated
  or damaged image throws `PDFImageCorruptError`; an unsupported type throws
  `PDFImageUnsupportedTypeError`. None of the errors carry image contents or
  paths, only the image's `index`. Bad option values and an empty list throw
  `PDFGenerationError`. PNG data is checksummed and size-checked before
  decoding.

### HTML

`renderHtmlToPdf()` uses `puppeteer-core` and never downloads a browser. Install
Chromium in the runtime image or set `PUPPETEER_EXECUTABLE_PATH`.

```typescript
import { writeFile } from 'node:fs/promises';
import { renderHtmlToPdf } from '@happyvertical/pdf';

const pdf = await renderHtmlToPdf('<h1>Invoice</h1>', {
  format: 'Letter',
  margin: { top: '0.5in', bottom: '0.5in' },
});

await writeFile('invoice.pdf', pdf);
```

You can also pass `executablePath` directly or call
`resolveChromiumExecutablePath()` to inspect what binary will be used.

## Configuration

```typescript
import { getPDFReader } from '@happyvertical/pdf';

const reader = await getPDFReader({
  provider: 'auto',
  enableOCR: true,
  timeout: 30_000,
  maxFileSize: 50 * 1024 * 1024,
  ocrProvider: 'auto',
  defaultOCROptions: {
    language: 'eng',
    confidenceThreshold: 70,
  },
});
```

Environment variables use the `HAVE_PDF_` prefix and are merged with explicit
options. Explicit options always win.

| Environment variable | Type | Example |
| --- | --- | --- |
| `HAVE_PDF_ENABLE_OCR` | boolean | `true` |
| `HAVE_PDF_TIMEOUT` | number | `30000` |
| `HAVE_PDF_PROVIDER` | string | `auto`, `unpdf`, `kreuzberg`, `paddleocr` |
| `HAVE_PDF_OCR_PROVIDER` | string | `auto`, `tesseract`, `onnx` |
| `HAVE_PDF_MAX_FILE_SIZE` | number | `52428800` |
| `HAVE_PDF_PADDLEOCR_URL` | string | `http://paddleocr-vl:8080` |
| `HAVE_PDF_PADDLEOCR_API_KEY` | string | bearer token, optional |
| `HAVE_PDF_PADDLEOCR_PREFER_EMBEDDED_TEXT` | boolean | `true` |

## Providers

- `auto`: default. In Node.js, uses the combined `unpdf` plus OCR reader.
- `unpdf`: Node.js text, metadata, image extraction, page rendering, and OCR
  fallback through `@happyvertical/ocr`.
- `kreuzberg`: optional Node.js provider via `@kreuzberg/node`; useful when
  available, but not required.
- `paddleocr`: Node.js reader backed by a remote PaddleOCR-VL service (see
  [PaddleOCR-VL as a reader](#paddleocr-vl-as-a-reader)). Used only when named;
  `auto` never selects it.

The `pdfjs` provider is not a stable public package target yet.

Automatic selection stays on `unpdf` when `enableOCR` is `false` or
`ocrProvider` names a backend Kreuzberg cannot serve, since Kreuzberg is in the
chain for its integrated OCR.

### Kreuzberg needs an AVX2-capable CPU

The prebuilt `@kreuzberg/node` binary executes AVX2 instructions, so using it on
a pre-AVX2 x86-64 host (`x86-64-v2` and below) raises `SIGILL` and terminates the
process. The binary is loaded lazily on the first native call, so any code that
merely asks whether the provider works is enough to trigger it.
`optionalDependencies` cannot prevent this: npm and pnpm only skip a package by
`os`, `cpu`, or `libc`, and AVX2 is a microarchitecture level rather than an
architecture.

This package therefore reads the `avx2` flag from `/proc/cpuinfo` before loading
anything native. Automatic selection falls back to `unpdf` when the flag is
absent. Requesting `provider: 'kreuzberg'` explicitly still returns a reader,
and that reader degrades the same way it does for any other missing dependency
rather than killing the process: `checkDependencies()` reports
`available: false` with an error naming AVX2, and extraction calls return their
empty result. Check `checkDependencies()` before relying on this provider.

Non-Linux and non-x86-64 hosts keep attempting the load: their CPU flags are not
readable this way, and the fault has only been observed on older Linux servers.

## Errors

```typescript
import {
  PDFDependencyError,
  PDFFileSizeError,
  PDFImageCollectionLimitError,
  PDFImageCorruptError,
  PDFImageLimitExceededError,
  PDFImageUnsupportedTypeError,
  PDFOCRFallbackError,
  PDFUnsupportedError,
  getPDFReader,
} from '@happyvertical/pdf';

try {
  const reader = await getPDFReader();
  await reader.extractText('/path/to/document.pdf');
} catch (error) {
  if (error instanceof PDFDependencyError) {
    console.error('Missing dependency:', error.message);
  } else if (error instanceof PDFFileSizeError) {
    console.error('File too large:', error.message);
  } else if (error instanceof PDFImageCollectionLimitError) {
    console.error('Use batched image extraction:', error.message);
  } else if (error instanceof PDFOCRFallbackError) {
    console.error('OCR fallback failed:', error.message);
  } else if (error instanceof PDFUnsupportedError) {
    console.error('Unsupported operation:', error.message);
  } else {
    throw error;
  }
}
```

## Legacy Compatibility

These exports remain for older callers, but new code should use
`getPDFReader()`.

```typescript
import {
  checkOCRDependencies,
  extractImagesFromPDF,
  extractTextFromPDF,
  performOCROnImages,
} from '@happyvertical/pdf';
```

## Development

Lifecycle-protected pull requests merge through the managed merge queue so the
synthetic merge revision is revalidated before it reaches `main`.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm docs:api
pnpm docs:api:check
pnpm pack --dry-run
```

The package ships generated JavaScript and declaration files from `dist/`.
Run `pnpm build` to refresh the declarations before inspecting the full API
surface locally. The generated API reference lives in `docs/api/`; run
`pnpm docs:api` after changing public exports or JSDoc, and run
`pnpm docs:api:check` to verify the committed reference is current. Generate and verify
these docs with Node 24, matching CI: TypeDoc compresses its search and navigation
indexes with the runtime’s zlib, so Node 26 emits different bytes for the same JSON.

## License

MIT. See [LICENSE](LICENSE).

## Remote PaddleOCR-VL document parsing

### PaddleOCR-VL as a reader

`getPDFReader({ provider: 'paddleocr' })` (or `HAVE_PDF_PROVIDER=paddleocr`)
returns a complete `PDFReader` that reads through a PaddleOCR-VL
`/layout-parsing` service, so code written against the reader interface can
switch to it without change:

| Operation | Served by |
| --- | --- |
| `extractText` | PaddleOCR-VL. Returns its Markdown (tables as HTML); `pages` selects from the parsed pages, so the whole document is parsed once per call. |
| `performOCR(images)` | PaddleOCR-VL, one request per image, in order. PNG and JPEG are sent as they are; WebP and raw pixels are converted to PNG first. `confidence` is 100 for any text (the service reports none). |
| `getInfo`, `extractMetadata`, `extractImages`, `renderPages` | Local `unpdf`. The service returns no document metadata, embedded images or page rasters. |

```typescript
const reader = await getPDFReader({
  provider: 'paddleocr',
  paddleocr: {
    baseUrl: 'http://paddleocr-vl:8080', // or HAVE_PDF_PADDLEOCR_URL
    preferEmbeddedText: false, // true: read text-layer PDFs locally
  },
});
const markdown = await reader.extractText('/path/to/scan.pdf');
```

- **Explicit only.** The document leaves the process, so `auto` never picks
  this provider. A missing or invalid service URL fails at `getPDFReader()`.
- **Embedded text.** By default the service reads every document, including
  ones with a text layer. With `preferEmbeddedText: true`, a document whose
  `getInfo` strategy is `text` is read locally instead; scanned and mixed ones
  still go to the service. `extractText(..., { skipOCRFallback: true })` always
  returns only the local text layer.
- **No fallback.** A service failure throws `PaddleOCRError`. The reader never
  retries and never substitutes a local OCR engine. Any `ocrProvider` other
  than `auto` (including `tesseract`) is refused.
- **Limits.** `paddleocr.maxFileSize` defaults to the reader's `maxFileSize`,
  then 50 MiB. `paddleocr.timeout` defaults to 65 minutes and does not inherit
  the reader's `timeout`, which is sized for local parsing; a shorter value
  also bounds the service's cold start.
- **Pages.** If the service returns a different number of pages than the
  document has, `extractText` throws `PaddleOCRError` (`EPADDLERESPONSE`)
  rather than returning short text. `enableOCR: false` reads only the local
  text layer and sends nothing.
- **Images.** WebP (the default output of `extractImages`) is converted to PNG
  before it is sent.

Use `PaddleOCRClient` directly when you need the per-page `layout` objects.

### The client

Use the explicit `PaddleOCRClient` when you want the full layout-aware PaddleOCR
pipeline, including tables and page structure, even for PDFs with embedded text.
It calls `/layout-parsing`, not an OpenAI-compatible VLM endpoint. The
`paddleocr` reader above is built on it; `auto` selection and the image OCR
providers are unchanged.

```typescript
import { PaddleOCRClient } from '@happyvertical/pdf';

const parser = new PaddleOCRClient({
  baseUrl: 'http://paddleocr-vl', // Snail tailnet endpoint
  // In cluster: http://paddleocr-vl.paddleocr-vl.svc.cluster.local
  timeout: 65 * 60 * 1000, // includes on-demand wake and response download
});
const result = await parser.parse('/path/to/document.pdf', {
  signal: AbortSignal.timeout(65 * 60 * 1000),
});
console.log(result.markdown);
for (const page of result.pages) {
  console.log(page.pageNumber, page.markdown, page.layout);
}
```

`baseUrl` defaults to `HAVE_PDF_PADDLEOCR_URL`; an optional `apiKey` defaults to
`HAVE_PDF_PADDLEOCR_API_KEY` and becomes a bearer header for authenticated proxies.
Explicit options take precedence. Snail uses private tailnet/namespace access,
not built-in bearer authentication; configure that boundary in `iac` before
exposing this endpoint elsewhere. In-cluster callers must be in a namespace
labelled `happyvertical.com/paddleocr-client: "true"`.

Inputs are local paths, `ArrayBuffer`, or `Uint8Array` (including `Buffer`).
Strings are never fetched as remote URLs. Inputs are validated for a PDF header
and limited to 50 MiB by default (`maxFileSize` overrides this). The service's
70 MiB JSON body limit accommodates that PDF after base64 encoding. The client
holds the PDF and encoded request in memory. It returns ordered, one-based pages,
per-page raw layout objects, and joined Markdown. Unknown layout labels are kept.
Set `returnMarkdownImages: true` to receive the image data/URLs referenced by
Markdown; by default these are omitted to reduce response size. Treat returned
Markdown, HTML tables, and image URLs as untrusted document content.

The first request after idle waits for the model. Images may take longer to pull
on the first deployment than the proxy's five-minute wake window; retry after
startup completes. Requests are **not automatically retried**, because a timeout
or disconnect does not guarantee server-side parsing stopped. `PaddleOCRError`
uses `ETIMEDOUT`, `EABORT`, `EPADDLEHTTP` (with `status`), `EPADDLEAPI`,
`EPADDLERESPONSE`, or `EPADDLEIO`; invalid input uses `PDFError` and size violations
use `PDFFileSizeError`. Error messages do not echo document contents or credentials.
A proxy `/health` success means the wake route exists, not that the GPU is warm.
The initial service handles one document at a time; serialize submissions and
split very long documents. Its idle expiry does not track an in-flight request,
and client cancellation does not cancel GPU processing.
