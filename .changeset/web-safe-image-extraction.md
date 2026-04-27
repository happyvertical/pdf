---
'@happyvertical/pdf': minor
---

Make `extractImages` produce web-safe output by default and standardize `PDFImage.format` to canonical IANA mime types.

Closes #73, closes #74. Companion to https://github.com/happyvertical/ocr/issues/75 (PR #76) — `PDFImage` now also carries `bitsPerComponent`, so consumers can decode raw pixel buffers without ambiguous heuristics.

### What changed

- `extractImages(source, options)` now accepts `outputFormat: 'webp' | 'png' | 'jpeg' | 'original'` and re-encodes raw image streams via `@napi-rs/canvas`. The default is `'webp'` so callers can store / serve `image.data` directly.
- `renderPages(source, options)` accepts the same `outputFormat` option. Default remains `'original'` (raw 8-bit RGB) so the OCR fallback path stays zero-copy.
- `PDFImage.format` is now a canonical lowercase IANA mime type (`image/jpeg`, `image/png`, `image/webp`, `image/x-rgb`, `image/x-rgba`, `image/x-grayscale`, `image/x-cmyk`, or `application/octet-stream`) instead of provider-specific values like `'rgb'` or `'unknown'`.
- `PDFImage.bitsPerComponent` is populated for raw pixel outputs (always `8` from unpdf), unblocking the planned `OCRImage.bitsPerComponent` field upstream.
- New exports: `canonicalizeImageFormat(format, channels?)` (pure helper) and `encodePDFImage(image, target?, options?)` (lazy Node-only re-encoder).

### Migration

- Callers that consumed raw RGB bytes (`format === 'rgb'`) should pass `outputFormat: 'original'` to keep the previous behavior, and update format checks to `image.format === 'image/x-rgb'`.
- Callers that re-encoded extracted images downstream (e.g. via `sharp`) can drop their re-encoder; `image.data` is now WebP by default.
- Streaming callers using `extractImages(source, { onBatch })` are also affected: each batch's `images[].data` is now WebP unless `outputFormat: 'original'` is passed.
- OCR-on-extracted-images flows that fed `extractImages()` results directly into `performOCR()` should pass `outputFormat: 'original'` (raw RGB is the OCR fast path) or the encoded format their OCR provider supports. Internal OCR fallback (`extractText()` / `renderPages()` → OCR) is unaffected.
- Encoded outputs (`outputFormat: 'webp' | 'png' | 'jpeg'`) drop `channels` and `bitsPerComponent` from the returned `PDFImage` so the encoded buffer cannot be misinterpreted as raw pixel data by OCR providers that key on `width && height && channels`. `width` and `height` remain set as metadata.
- Raw outputs (`outputFormat: 'original'`) now also carry `bitsPerComponent: 8`, so consumers can decode the buffer unambiguously without the 1-channel-16-bit vs. 2-channel-8-bit collision (companion to https://github.com/happyvertical/ocr/issues/75).
