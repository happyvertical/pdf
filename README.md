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
| `HAVE_PDF_PROVIDER` | string | `auto`, `unpdf`, `kreuzberg` |
| `HAVE_PDF_OCR_PROVIDER` | string | `auto`, `tesseract`, `onnx` |
| `HAVE_PDF_MAX_FILE_SIZE` | number | `52428800` |

## Providers

- `auto`: default. In Node.js, uses the combined `unpdf` plus OCR reader.
- `unpdf`: Node.js text, metadata, image extraction, page rendering, and OCR
  fallback through `@happyvertical/ocr`.
- `kreuzberg`: optional Node.js provider via `@kreuzberg/node`; useful when
  available, but not required.

The `pdfjs` provider is not a stable public package target yet.

## Errors

```typescript
import {
  PDFDependencyError,
  PDFFileSizeError,
  PDFImageCollectionLimitError,
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

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm pack --dry-run
```

The package ships generated JavaScript and declaration files from `dist/`.
Run `pnpm build` to refresh the declarations before inspecting the full API
surface locally.

## License

MIT. See [LICENSE](LICENSE).
