/**
 * @happyvertical/pdf - Build a PDF from images, without a browser.
 *
 * `imagesToPdf` puts one image on each page, in the given order, using
 * `pdf-lib` only: PNG and JPEG are embedded natively. WebP is refused with a
 * typed error: `@napi-rs/canvas` can spin forever on a damaged WebP, so it
 * must not decode untrusted bytes. There is no headless browser, no network,
 * and no filesystem write.
 *
 * The inputs are untrusted bytes. The type is decided from the file
 * signature, the headers are parsed by small bounded parsers (dimensions and
 * the JPEG EXIF orientation) before anything is decoded, and the page count,
 * per-image bytes, total bytes and decoded pixel count are limited. Failures
 * are typed (`PDFImageUnsupportedTypeError`, `PDFImageCorruptError`,
 * `PDFImageLimitExceededError`) and never carry image contents or paths.
 */

import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, inflate } from 'node:zlib';

const inflateAsync = promisify(inflate);

import {
  clip,
  concatTransformationMatrix,
  endPath,
  PDFDocument,
  type PDFPage,
  type PDFImage as PdfLibImage,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib';
import { PDFGenerationError } from '../generation/markdown-pdf';
import {
  PDFImageCorruptError,
  PDFImageInputError,
  PDFImageLimitExceededError,
  PDFImageUnsupportedTypeError,
} from '../shared/types';

/** One image: encoded bytes, or a filesystem path to read them from. */
export type ImagesToPdfInput = Buffer | Uint8Array | string;

/** Named page sizes, portrait, in points (1pt = 1/72in). */
const NAMED_PAGE_SIZES: Record<
  ImagesToPdfPageSizeName,
  readonly [number, number]
> = {
  letter: [612, 792],
  legal: [612, 1008],
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
};

/** Name of a built-in page size. */
export type ImagesToPdfPageSizeName = 'letter' | 'legal' | 'a3' | 'a4' | 'a5';

/** An explicit page size in points. */
export interface ImagesToPdfPageDimensions {
  width: number;
  height: number;
}

/** Options for {@link imagesToPdf}. */
export interface ImagesToPdfOptions {
  /**
   * Page size. `'image'` (default): each page matches its image at `dpi`
   * (plus `margin` on every side). Otherwise a named size or explicit points.
   */
  pageSize?: 'image' | ImagesToPdfPageSizeName | ImagesToPdfPageDimensions;
  /** Pixels per inch used when `pageSize` is `'image'`. Default 150. */
  dpi?: number;
  /**
   * `'contain'` (default): the whole image is visible, centred. `'cover'`:
   * the image fills the area inside the margin and is cropped to it.
   */
  fit?: 'contain' | 'cover';
  /** Margin in points on every side. Default 0. */
  margin?: number;
  /**
   * For named or explicit sizes: `'auto'` (default) picks portrait or
   * landscape per image from its upright shape; `'portrait'` / `'landscape'`
   * force one. Ignored when `pageSize` is `'image'`.
   */
  orientation?: 'auto' | 'portrait' | 'landscape';
  /** PDF metadata title. */
  title?: string;
  /**
   * Creation and modification date. Pass it for byte-identical output from
   * identical inputs; the default is the current time.
   */
  creationDate?: Date;
  /** Maximum number of images. Default 100. */
  maxImages?: number;
  /** Maximum encoded bytes per image. Default 25 MiB. */
  maxImageBytes?: number;
  /** Maximum encoded bytes over all images. Default 256 MiB. */
  maxTotalBytes?: number;
  /** Maximum decoded pixels (width x height) per image. Default 50 million. */
  maxImagePixels?: number;
}

const IMAGES_TO_PDF_DEFAULTS = {
  dpi: 150,
  maxImages: 100,
  maxImageBytes: 25 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxImagePixels: 50_000_000,
} as const;

type ImageKind = 'png' | 'jpeg';

interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
  /** EXIF orientation 1-8 (JPEG only; 1 otherwise). */
  orientation: number;
}

/** Detect the image type from the file signature only. */
export function detectImageKind(b: Uint8Array): ImageKind | undefined {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'jpeg';
  }
  return undefined;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++)
    s += String.fromCharCode(b[i]);
  return s;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

class Corrupt extends Error {}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

interface PngInfo extends ImageInfo {
  /** Concatenated IDAT payload (still zlib-compressed). */
  idat: Buffer[];
  /** Exact inflated size the header promises. */
  rawSize: number;
}

/** Inflated size of a PNG image, from its header. */
function pngRawSize(
  w: number,
  h: number,
  bitsPerPixel: number,
  interlaced: boolean,
): number {
  const rows = (width: number, height: number) =>
    width === 0 || height === 0
      ? 0
      : height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  if (!interlaced) return rows(w, h);
  // Adam7 passes: [xStart, yStart, xStep, yStep]
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    total += rows(Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy));
  }
  return total;
}

function parsePng(b: Uint8Array): PngInfo {
  if (b.length < 33 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') {
    throw new Corrupt('PNG header');
  }
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const depth = b[24];
  const colorType = b[25];
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff
  ) {
    throw new Corrupt('PNG size');
  }
  if (
    !PNG_DEPTHS[colorType]?.includes(depth) ||
    b[26] !== 0 ||
    b[27] !== 0 ||
    b[28] > 1
  ) {
    throw new Corrupt('PNG header');
  }
  // Walk the chunk list: every length must fit, every CRC must match, and
  // IEND must be present. This runs before pdf-lib sees a single byte.
  let pos = 8;
  let sawEnd = false;
  const idat: Buffer[] = [];
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  while (pos + 12 <= b.length) {
    const len = u32be(b, pos);
    if (len > b.length - pos - 12) throw new Corrupt('PNG chunk');
    const type = ascii(b, pos + 4, 4);
    if (
      crc32(buf.subarray(pos + 4, pos + 8 + len)) !== u32be(b, pos + 8 + len)
    ) {
      throw new Corrupt('PNG checksum');
    }
    // A second IHDR would override the validated dimensions inside pdf-lib's
    // decoder, and APNG animation chunks make it decode frames this module
    // does not bound. Neither is a still image this call accepts.
    if (
      type === 'IHDR' ||
      type === 'acTL' ||
      type === 'fcTL' ||
      type === 'fdAT'
    ) {
      if (pos !== 8 || type !== 'IHDR') throw new Corrupt('PNG chunk');
    }
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    pos += 12 + len;
  }
  if (!sawEnd || idat.length === 0) throw new Corrupt('PNG truncated');
  const rawSize = pngRawSize(
    width,
    height,
    PNG_CHANNELS[colorType] * depth,
    b[28] === 1,
  );
  return { kind: 'png', width, height, orientation: 1, idat, rawSize };
}

/**
 * Inflate the PNG pixel stream under a hard output cap and require it to be
 * exactly the size the header promises. pdf-lib's own PNG decoder can spin on
 * damaged streams, so it only ever sees data that passed this.
 */
async function verifyPngStream(info: PngInfo): Promise<void> {
  let raw: Buffer;
  try {
    raw = await inflateAsync(Buffer.concat(info.idat), {
      maxOutputLength: info.rawSize + 1,
    });
  } catch {
    throw new Corrupt('PNG data');
  }
  if (raw.length !== info.rawSize) throw new Corrupt('PNG data');
}

/** Read the orientation from an EXIF APP1 payload; 1 when absent or invalid. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  // start points at "Exif\0\0"; TIFF header follows.
  if (end - start < 14 || ascii(b, start, 4) !== 'Exif') return 1;
  const t = start + 6;
  const le = ascii(b, t, 2) === 'II';
  if (!le && ascii(b, t, 2) !== 'MM') return 1;
  const r16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : u16be(b, o));
  const r32 = (o: number) =>
    le
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : u32be(b, o);
  if (r16(t + 2) !== 0x2a) return 1;
  const ifd = t + r32(t + 4);
  if (ifd < t || ifd + 2 > end) return 1;
  const count = Math.min(r16(ifd), 256);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function parseJpeg(b: Uint8Array): ImageInfo {
  let pos = 2;
  let orientation = 1;
  let sawExif = false;
  let scanStart = -1;
  let dims: { width: number; height: number } | undefined;
  // Each iteration consumes at least one byte, so this is O(length).
  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new Corrupt('JPEG marker');
    while (pos < b.length && b[pos] === 0xff) pos++;
    const m = b[pos++];
    if (m === undefined) break;
    if (m === 0xd9) break; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8) || m === 0x00) continue;
    if (pos + 2 > b.length) throw new Corrupt('JPEG segment');
    const len = u16be(b, pos);
    if (len < 2 || pos + len > b.length) throw new Corrupt('JPEG segment');
    if (m === 0xe1 && !sawExif && ascii(b, pos + 2, 4) === 'Exif') {
      sawExif = true;
      orientation = exifOrientation(b, pos + 2, pos + len);
    }
    const isSof =
      m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      // Only baseline (C0), extended sequential (C1) and progressive (C2)
      // DCT are valid in a PDF DCTDecode stream.
      if (m > 0xc2) throw new Corrupt('JPEG process');
      if (len < 8) throw new Corrupt('JPEG frame');
      const height = u16be(b, pos + 3);
      const width = u16be(b, pos + 5);
      const comps = b[pos + 7];
      if (width === 0 || height === 0) throw new Corrupt('JPEG size');
      if (comps !== 1 && comps !== 3 && comps !== 4)
        throw new Corrupt('JPEG components');
      dims = { width, height };
    }
    if (m === 0xda) {
      // start of scan: the headers are behind us
      scanStart = pos + len;
      break;
    }
    pos += len;
  }
  if (!dims) throw new Corrupt('JPEG frame');
  if (scanStart < 0) throw new Corrupt('JPEG scan');
  // The end-of-image marker must be near the end, otherwise it was cut off.
  const tail = Math.max(2, b.length - 4096);
  let sawEoi = false;
  for (let i = b.length - 2; i >= tail; i--) {
    if (b[i] === 0xff && b[i + 1] === 0xd9 && i > scanStart) {
      sawEoi = true;
      break;
    }
  }
  if (!sawEoi) throw new Corrupt('JPEG truncated');
  return { kind: 'jpeg', ...dims, orientation };
}

/** Normalised map from stored image space to upright space, per EXIF value. */
const ORIENTATION_MAP: Record<
  number,
  readonly [number, number, number, number, number, number]
> = {
  // [xu, xv, xc, yu, yv, yc]: X = xu*u + xv*v + xc ; Y = yu*u + yv*v + yc
  // (u right, v up in the stored image; X right, Y up once upright.)
  1: [1, 0, 0, 0, 1, 0],
  2: [-1, 0, 1, 0, 1, 0],
  3: [-1, 0, 1, 0, -1, 1],
  4: [1, 0, 0, 0, -1, 1],
  5: [0, -1, 1, -1, 0, 1],
  6: [0, 1, 0, -1, 0, 1],
  7: [0, 1, 0, 1, 0, 0],
  8: [0, -1, 1, 1, 0, 0],
};

/**
 * PDF transformation matrix that draws a unit-square image upright into the
 * box at (x, y) of size w x h (the upright size).
 * @internal
 */
export function orientationMatrix(
  orientation: number,
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  const [xu, xv, xc, yu, yv, yc] =
    ORIENTATION_MAP[orientation] ?? ORIENTATION_MAP[1];
  return [w * xu, h * yu, w * xv, h * yv, x + w * xc, y + h * yc];
}

/** Upright size in pixels after applying the orientation. */
function uprightSize(info: ImageInfo): [number, number] {
  return info.orientation >= 5
    ? [info.height, info.width]
    : [info.width, info.height];
}

function positiveFinite(name: string, v: number, max: number): number {
  if (!Number.isFinite(v) || v <= 0 || v > max) {
    throw new PDFGenerationError(
      `${name} must be a positive number up to ${max}`,
    );
  }
  return v;
}

function limitOption(name: string, v: number | undefined, def: number): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < 1) {
    throw new PDFGenerationError(`${name} must be a positive integer`);
  }
  return v;
}

async function loadBytes(
  input: ImagesToPdfInput,
  index: number,
  maxBytes: number,
  remainingTotal: number,
  maxTotalBytes: number,
): Promise<Uint8Array> {
  const tooBig = (actual: number): PDFImageLimitExceededError =>
    actual > maxBytes
      ? new PDFImageLimitExceededError('maxImageBytes', actual, maxBytes, index)
      : new PDFImageLimitExceededError(
          'maxTotalBytes',
          maxTotalBytes - remainingTotal + actual,
          maxTotalBytes,
          index,
        );
  const cap = Math.min(maxBytes, remainingTotal);
  if (typeof input === 'string') {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(input, 'r');
    } catch {
      throw new PDFImageCorruptError(index, 'unreadable file');
    }
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new PDFImageCorruptError(index, 'unreadable file');
      if (s.size > cap) throw tooBig(s.size);
      // The file may grow after stat: read through this one handle and never
      // more than the cap, so the allocation stays bounded.
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(1 << 20, cap + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > cap) throw tooBig(total);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } catch (e) {
      if (e instanceof PDFImageInputError) throw e;
      throw new PDFImageCorruptError(index, 'unreadable file');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  if (!(input instanceof Uint8Array)) {
    throw new PDFImageUnsupportedTypeError(index);
  }
  if (input.byteLength > cap) throw tooBig(input.byteLength);
  return input;
}

function inspect(bytes: Uint8Array, index: number): ImageInfo {
  const kind = detectImageKind(bytes);
  if (!kind) throw new PDFImageUnsupportedTypeError(index);
  try {
    return kind === 'png' ? parsePng(bytes) : parseJpeg(bytes);
  } catch (e) {
    if (e instanceof Corrupt) throw new PDFImageCorruptError(index, e.message);
    throw new PDFImageCorruptError(index);
  }
}

async function embed(
  doc: PDFDocument,
  bytes: Uint8Array,
  info: ImageInfo,
  index: number,
): Promise<PdfLibImage> {
  try {
    // pdf-lib reads `bytes.buffer` whole, so it must be an exact-size copy,
    // never a view into a larger (pooled) ArrayBuffer.
    if (info.kind === 'png') return await doc.embedPng(new Uint8Array(bytes));
    return await doc.embedJpg(new Uint8Array(bytes));
  } catch {
    throw new PDFImageCorruptError(index, `${info.kind} decode failed`);
  }
}

function pageDimensions(
  pageSize: NonNullable<ImagesToPdfOptions['pageSize']>,
  orientation: NonNullable<ImagesToPdfOptions['orientation']>,
  upright: [number, number],
  dpi: number,
  margin: number,
): [number, number] {
  if (pageSize === 'image') {
    return [
      (upright[0] * 72) / dpi + 2 * margin,
      (upright[1] * 72) / dpi + 2 * margin,
    ];
  }
  let w: number;
  let h: number;
  if (typeof pageSize === 'string') {
    const named = Object.hasOwn(NAMED_PAGE_SIZES, pageSize)
      ? NAMED_PAGE_SIZES[pageSize]
      : undefined;
    if (!named) throw new PDFGenerationError(`Unknown pageSize '${pageSize}'`);
    [w, h] = named;
  } else {
    w = positiveFinite('pageSize.width', pageSize?.width, 14400);
    h = positiveFinite('pageSize.height', pageSize?.height, 14400);
  }
  const [short, long] = [Math.min(w, h), Math.max(w, h)];
  const landscape =
    orientation === 'auto'
      ? upright[0] > upright[1]
      : orientation === 'landscape';
  return landscape ? [long, short] : [short, long];
}

function drawImage(
  page: PDFPage,
  image: PdfLibImage,
  info: ImageInfo,
  upright: [number, number],
  fit: 'contain' | 'cover',
  margin: number,
): void {
  const { width: pw, height: ph } = page.getSize();
  const areaW = pw - 2 * margin;
  const areaH = ph - 2 * margin;
  const scale = (fit === 'cover' ? Math.max : Math.min)(
    areaW / upright[0],
    areaH / upright[1],
  );
  const w = upright[0] * scale;
  const h = upright[1] * scale;
  const x = margin + (areaW - w) / 2;
  const y = margin + (areaH - h) / 2;
  const m = orientationMatrix(info.orientation, x, y, w, h);
  page.pushOperators(pushGraphicsState());
  if (fit === 'cover') {
    page.pushOperators(
      rectangle(margin, margin, areaW, areaH),
      clip(),
      endPath(),
    );
  }
  page.pushOperators(concatTransformationMatrix(...m));
  page.drawImage(image, { x: 0, y: 0, width: 1, height: 1 });
  page.pushOperators(popGraphicsState());
}

/**
 * Build a PDF with one image per page, in order, without a browser.
 *
 * Accepts PNG and JPEG (WebP is refused), detected by file signature. JPEG EXIF
 * orientation is honoured. Returns the PDF bytes; nothing is written to disk.
 *
 * @throws {PDFImageUnsupportedTypeError} An input is not PNG or JPEG (including WebP).
 * @throws {PDFImageCorruptError} An input is truncated, malformed, or unreadable.
 * @throws {PDFImageLimitExceededError} A count, size, or pixel limit is exceeded.
 * @throws {PDFGenerationError} The option values or the image list are invalid.
 */
export async function imagesToPdf(
  images: ImagesToPdfInput[],
  options: ImagesToPdfOptions = {},
): Promise<Uint8Array> {
  if (!Array.isArray(images) || images.length === 0) {
    throw new PDFGenerationError('imagesToPdf needs at least one image');
  }
  const d = IMAGES_TO_PDF_DEFAULTS;
  const maxImages = limitOption('maxImages', options.maxImages, d.maxImages);
  const maxImageBytes = limitOption(
    'maxImageBytes',
    options.maxImageBytes,
    d.maxImageBytes,
  );
  const maxTotalBytes = limitOption(
    'maxTotalBytes',
    options.maxTotalBytes,
    d.maxTotalBytes,
  );
  const maxPixels = limitOption(
    'maxImagePixels',
    options.maxImagePixels,
    d.maxImagePixels,
  );
  const dpi = positiveFinite('dpi', options.dpi ?? d.dpi, 10000);
  const margin = options.margin ?? 0;
  if (!Number.isFinite(margin) || margin < 0 || margin > 14400) {
    throw new PDFGenerationError(
      'margin must be a number of points from 0 to 14400',
    );
  }
  const fit = options.fit ?? 'contain';
  if (fit !== 'contain' && fit !== 'cover') {
    throw new PDFGenerationError("fit must be 'contain' or 'cover'");
  }
  const orientation = options.orientation ?? 'auto';
  if (!['auto', 'portrait', 'landscape'].includes(orientation)) {
    throw new PDFGenerationError(
      "orientation must be 'auto', 'portrait' or 'landscape'",
    );
  }
  const pageSize = options.pageSize ?? 'image';
  if (
    options.creationDate !== undefined &&
    Number.isNaN(options.creationDate?.getTime?.())
  ) {
    throw new PDFGenerationError('creationDate must be a valid Date');
  }
  if (images.length > maxImages) {
    throw new PDFImageLimitExceededError('maxImages', images.length, maxImages);
  }

  const doc = await PDFDocument.create({ updateMetadata: false });
  const date = options.creationDate ?? new Date();
  doc.setProducer('@happyvertical/pdf');
  doc.setCreator('@happyvertical/pdf');
  doc.setCreationDate(date);
  doc.setModificationDate(date);
  if (options.title !== undefined) doc.setTitle(String(options.title));

  let total = 0;
  for (let i = 0; i < images.length; i++) {
    const bytes = await loadBytes(
      images[i],
      i,
      maxImageBytes,
      maxTotalBytes - total,
      maxTotalBytes,
    );
    total += bytes.byteLength;
    if (total > maxTotalBytes) {
      throw new PDFImageLimitExceededError(
        'maxTotalBytes',
        total,
        maxTotalBytes,
        i,
      );
    }
    const info = inspect(bytes, i);
    if (info.width * info.height > maxPixels) {
      throw new PDFImageLimitExceededError(
        'maxImagePixels',
        info.width * info.height,
        maxPixels,
        i,
      );
    }
    if (info.kind === 'png') {
      try {
        await verifyPngStream(info as PngInfo);
      } catch {
        throw new PDFImageCorruptError(i, 'PNG data');
      }
    }
    const embedded = await embed(doc, bytes, info, i);
    const upright = uprightSize(info);
    const [pw, ph] = pageDimensions(
      pageSize,
      orientation,
      upright,
      dpi,
      margin,
    );
    if (margin * 2 >= Math.min(pw, ph)) {
      throw new PDFGenerationError('margin leaves no room for the image');
    }
    const page = doc.addPage([pw, ph]);
    drawImage(page, embedded, info, upright, fit, margin);
  }
  return doc.save();
}
