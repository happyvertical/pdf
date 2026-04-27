/**
 * @happyvertical/pdf - Web-safe re-encoding for extracted PDF images.
 *
 * `extractImages` and `renderPages` produce raw pixel buffers (RGB / RGBA /
 * grayscale) or raw provider streams that downstream consumers cannot store
 * or render directly. This module re-encodes those buffers to canonical
 * web-safe formats (WebP / PNG / JPEG) using `@napi-rs/canvas`, the same
 * canvas dependency we already pull in for `renderPages`.
 *
 * See:
 * - https://github.com/happyvertical/pdf/issues/73 — web-safe output by default.
 * - https://github.com/happyvertical/pdf/issues/74 — canonical IANA mime types.
 */

import { Canvas, ImageData } from '@napi-rs/canvas';
import { canonicalizeImageFormat } from '../shared/image-format';
import type {
  ImageEncodingOptions,
  PDFImage,
  PDFImageMimeType,
  PDFImageOutputFormat,
} from '../shared/types';

export { canonicalizeImageFormat };

const DEFAULT_WEBP_QUALITY = 86;
const DEFAULT_JPEG_QUALITY = 85;

/** Mime type emitted by the encoder for each web-safe target. */
const ENCODED_MIME_TYPES: Record<
  Exclude<PDFImageOutputFormat, 'original'>,
  PDFImageMimeType
> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/**
 * Whether a `PDFImage` carries raw 8-bit pixel data we can safely re-encode.
 *
 * The byte length must match `width * height * channels` exactly — anything
 * else means the buffer is already encoded (JPEG / PNG / etc.) or that the
 * stream uses a non-8-bit layout (e.g. 16-bit grayscale) that we don't
 * recompose without `bitsPerComponent`. See ocr#75 for context on why
 * length-based inference alone is unsafe.
 */
function isRaw8BitPixelImage(image: PDFImage): image is PDFImage & {
  data: Buffer | Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
} {
  if (typeof image.data === 'string') return false;
  if (!image.width || !image.height) return false;
  if (image.channels !== 1 && image.channels !== 3 && image.channels !== 4) {
    return false;
  }

  const bps = image.bitsPerComponent ?? 8;
  if (bps !== 8) return false;

  const expectedBytes = image.width * image.height * image.channels;
  return image.data.byteLength === expectedBytes;
}

function expandToRGBA(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Uint8ClampedArray {
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);

  if (channels === 4) {
    rgba.set(raw);
    return rgba;
  }

  if (channels === 3) {
    for (let i = 0, j = 0; i < pixels; i++) {
      rgba[j++] = raw[i * 3];
      rgba[j++] = raw[i * 3 + 1];
      rgba[j++] = raw[i * 3 + 2];
      rgba[j++] = 255;
    }
    return rgba;
  }

  // grayscale
  for (let i = 0, j = 0; i < pixels; i++) {
    const v = raw[i];
    rgba[j++] = v;
    rgba[j++] = v;
    rgba[j++] = v;
    rgba[j++] = 255;
  }
  return rgba;
}

/**
 * Re-encode a `PDFImage` to a web-safe format.
 *
 * Returns a new `PDFImage` whose `data` is the encoded buffer and whose
 * `format` is the canonical IANA mime type of the encoding. When the input
 * is already an encoded blob (JPEG / PNG / WebP) and matches the requested
 * target, the original buffer is returned unchanged. When the input cannot
 * be safely re-encoded (unknown raw layout, no dimensions, etc.) the
 * original image is returned with a normalized `format`.
 *
 * @param image  - PDFImage produced by `extractImages` or `renderPages`.
 * @param target - Web-safe target format. `'original'` returns the input
 *                 with only its `format` canonicalized.
 * @param options - Quality / compression knobs for lossy formats.
 */
export async function encodePDFImage(
  image: PDFImage,
  target: PDFImageOutputFormat = 'webp',
  options: ImageEncodingOptions = {},
): Promise<PDFImage> {
  const canonicalFormat = canonicalizeImageFormat(image.format, image.channels);

  if (target === 'original') {
    return { ...image, format: canonicalFormat };
  }

  const targetMime = ENCODED_MIME_TYPES[target];

  // Pass-through when the source already matches the requested encoding.
  if (canonicalFormat === targetMime) {
    return { ...image, format: targetMime };
  }

  if (!isRaw8BitPixelImage(image)) {
    // We can't re-encode something that isn't a raw 8-bit pixel buffer.
    // Hand back the source bytes with the canonical mime so consumers can
    // route on `format` and fall back to magic-byte detection.
    return { ...image, format: canonicalFormat };
  }

  const { width, height, channels } = image;
  const rawData =
    image.data instanceof Uint8Array
      ? image.data
      : new Uint8Array(image.data as ArrayBuffer);
  const rgba = expandToRGBA(rawData, width, height, channels);

  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);

  let encoded: Buffer;
  if (target === 'png') {
    encoded = await canvas.encode('png');
  } else if (target === 'jpeg') {
    const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
    encoded = await canvas.encode('jpeg', quality);
  } else {
    const quality = options.quality ?? DEFAULT_WEBP_QUALITY;
    encoded = await canvas.encode('webp', quality);
  }

  // Help V8 release the canvas-backed pixel buffer eagerly; large pages
  // can otherwise pin memory across the whole batch.
  canvas.width = 0;
  canvas.height = 0;

  // For encoded outputs we deliberately drop `bitsPerComponent` and
  // `channels` because consumers should decode the encoded stream rather
  // than reinterpret raw bytes from the dimensions. Dropping `channels`
  // also defends against OCR providers that use an `(width && height &&
  // Buffer)` heuristic to take a raw-pixel fast path — without `channels`
  // the heuristic is more likely to fall through to magic-byte detection.
  // (Width / height stay set because they are useful metadata for
  // downstream storage; OCR-on-extracted-images flows should use
  // `outputFormat: 'original'`.)
  return {
    ...image,
    data: encoded,
    format: targetMime,
    bitsPerComponent: undefined,
    channels: undefined,
  };
}

/**
 * Apply `outputFormat` to a freshly-extracted batch of images.
 *
 * Skips encoding entirely when `target` is `'original'` so the hot path
 * (raw RGB → OCR) stays zero-copy.
 */
export async function applyOutputFormat(
  images: PDFImage[],
  target: PDFImageOutputFormat,
  options: ImageEncodingOptions = {},
): Promise<PDFImage[]> {
  if (target === 'original') {
    // Still canonicalize `format` per #74 even when not re-encoding.
    return images.map((image) => ({
      ...image,
      format: canonicalizeImageFormat(image.format, image.channels),
    }));
  }

  const encoded: PDFImage[] = [];
  for (const image of images) {
    encoded.push(await encodePDFImage(image, target, options));
  }
  return encoded;
}
