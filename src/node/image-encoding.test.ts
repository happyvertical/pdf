/**
 * Unit tests for the image-encoding helpers introduced for issues
 * #73 (web-safe output) and #74 (canonical mime types).
 */

import { describe, expect, it } from 'vitest';
import { canonicalizeImageFormat } from '../shared/image-format';
import type { PDFImage } from '../shared/types';
import { encodePDFImage } from './image-encoding';

function makeRawRGBImage(width = 4, height = 4): PDFImage {
  // 4x4 solid red — easy to verify across encodings.
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = 255;
    data[i * 3 + 1] = 0;
    data[i * 3 + 2] = 0;
  }
  return {
    data,
    width,
    height,
    channels: 3,
    bitsPerComponent: 8,
    format: 'image/x-rgb',
    pageNumber: 1,
  };
}

describe('canonicalizeImageFormat (issue #74)', () => {
  it('maps the documented variants to canonical IANA mime types', () => {
    expect(canonicalizeImageFormat('jpeg')).toBe('image/jpeg');
    expect(canonicalizeImageFormat('jpg')).toBe('image/jpeg');
    expect(canonicalizeImageFormat('image/jpg')).toBe('image/jpeg');
    expect(canonicalizeImageFormat('image/jpeg; charset=binary')).toBe(
      'image/jpeg',
    );
    expect(canonicalizeImageFormat('image/x-png')).toBe('image/png');
    expect(canonicalizeImageFormat('PNG')).toBe('image/png');
    expect(canonicalizeImageFormat('webp')).toBe('image/webp');
    expect(canonicalizeImageFormat('tiff')).toBe('image/tiff');
    expect(canonicalizeImageFormat('image/tif')).toBe('image/tiff');
    expect(canonicalizeImageFormat('rgb')).toBe('image/x-rgb');
    expect(canonicalizeImageFormat('rgba')).toBe('image/x-rgba');
    expect(canonicalizeImageFormat('grey')).toBe('image/x-grayscale');
    expect(canonicalizeImageFormat('cmyk')).toBe('image/x-cmyk');
  });

  it('infers from channels when the label is unknown / missing', () => {
    expect(canonicalizeImageFormat(undefined, 1)).toBe('image/x-grayscale');
    expect(canonicalizeImageFormat('unknown', 3)).toBe('image/x-rgb');
    expect(canonicalizeImageFormat('', 4)).toBe('image/x-rgba');
    expect(canonicalizeImageFormat('bin')).toBe('application/octet-stream');
  });
});

describe('encodePDFImage (issue #73)', () => {
  it('encodes raw RGB to WebP by default', async () => {
    const encoded = await encodePDFImage(makeRawRGBImage());

    expect(encoded.format).toBe('image/webp');
    const buf = encoded.data as Buffer;
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WEBP');
    // Encoded outputs deliberately drop `bitsPerComponent` and `channels`
    // so the buffer cannot be misinterpreted as raw pixel data by OCR
    // heuristics that key on `width && height && channels`.
    expect(encoded.bitsPerComponent).toBeUndefined();
    expect(encoded.channels).toBeUndefined();
  });

  it('encodes raw RGBA to WebP and preserves alpha-bearing pixels', async () => {
    const width = 4;
    const height = 4;
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 0;
      data[i * 4 + 1] = 128;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 200; // semi-transparent
    }
    const rgba: PDFImage = {
      data,
      width,
      height,
      channels: 4,
      bitsPerComponent: 8,
      format: 'image/x-rgba',
      pageNumber: 1,
    };

    const encoded = await encodePDFImage(rgba);
    expect(encoded.format).toBe('image/webp');
    const buf = encoded.data as Buffer;
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(encoded.channels).toBeUndefined();
  });

  it('encodes raw RGB to PNG when requested', async () => {
    const encoded = await encodePDFImage(makeRawRGBImage(), 'png');

    expect(encoded.format).toBe('image/png');
    const buf = encoded.data as Buffer;
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('encodes raw RGB to JPEG when requested', async () => {
    const encoded = await encodePDFImage(makeRawRGBImage(8, 8), 'jpeg');

    expect(encoded.format).toBe('image/jpeg');
    const buf = encoded.data as Buffer;
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it('returns the source unchanged for outputFormat=original (canonicalized format)', async () => {
    const original = makeRawRGBImage();
    const encoded = await encodePDFImage(original, 'original');

    expect(encoded.data).toBe(original.data);
    expect(encoded.format).toBe('image/x-rgb');
    expect(encoded.bitsPerComponent).toBe(8);
  });

  it('does not re-encode when source already matches target', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sourceImage: PDFImage = {
      data: png,
      width: 1,
      height: 1,
      format: 'image/png',
      pageNumber: 1,
    };

    const encoded = await encodePDFImage(sourceImage, 'png');
    expect(encoded.data).toBe(png);
    expect(encoded.format).toBe('image/png');
  });

  it('refuses to interpret raw bytes when bitsPerComponent disagrees', async () => {
    // Length-only inference is unsafe (ocr#75): a 1-channel × 16-bit image
    // is byte-indistinguishable from a 2-channel × 8-bit image. Mark
    // bitsPerComponent=16 so the helper takes the safe path: it does not
    // re-encode and simply canonicalizes the format.
    const sixteenBit: PDFImage = {
      data: Buffer.alloc(2 * 2 * 1 * 2), // 2x2 16-bit grayscale
      width: 2,
      height: 2,
      channels: 1,
      bitsPerComponent: 16,
      format: 'image/x-grayscale',
      pageNumber: 1,
    };

    const encoded = await encodePDFImage(sixteenBit, 'webp');
    // Helper returned source bytes with canonicalized format rather than
    // mis-decoding the buffer.
    expect(encoded.data).toBe(sixteenBit.data);
    expect(encoded.format).toBe('image/x-grayscale');
  });
});
