/**
 * @happyvertical/pdf - Canonical image format normalization.
 *
 * Producer-side `format` values vary widely (`'rgb'`, `'image/jpg'`,
 * `'image/x-png'`, `'application/octet-stream'`, etc.). This module returns a
 * canonical lowercase IANA mime type so consumers don't all reinvent the same
 * normalizer.
 *
 * This file deliberately has no Node-only dependencies so it can be
 * imported from the shared entry point and the browser bundle alike.
 */

import type { PDFImageMimeType } from './types';

/**
 * Canonicalize a producer-emitted `format` value to a lowercase IANA mime.
 *
 * `channels` is consulted as a fallback for unrecognized labels (raw streams
 * frequently arrive with `'unknown'` / `''` / `'application/octet-stream'`).
 */
export function canonicalizeImageFormat(
  format: string | undefined,
  channels?: number,
): PDFImageMimeType {
  const value = (format ?? '').trim().toLowerCase().split(';')[0].trim();

  switch (value) {
    case 'image/jpeg':
    case 'image/jpg':
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'image/png':
    case 'image/x-png':
    case 'png':
      return 'image/png';
    case 'image/webp':
    case 'webp':
      return 'image/webp';
    case 'image/tiff':
    case 'image/tif':
    case 'tiff':
    case 'tif':
      return 'image/tiff';
    case 'image/x-rgb':
    case 'rgb':
      return 'image/x-rgb';
    case 'image/x-rgba':
    case 'rgba':
      return 'image/x-rgba';
    case 'image/x-grayscale':
    case 'grayscale':
    case 'gray':
    case 'grey':
      return 'image/x-grayscale';
    case 'image/x-cmyk':
    case 'cmyk':
      return 'image/x-cmyk';
    case 'application/octet-stream':
      // Idempotent: an explicit `application/octet-stream` is a
      // deliberate "we don't know" / "opaque blob" signal from the
      // upstream extractor. Don't try to upgrade it to a raw `image/x-*`
      // mime via channel inference.
      return 'application/octet-stream';
    default:
      // Fall through to channel inference for unknown / empty labels.
      break;
  }

  if (channels === 1) return 'image/x-grayscale';
  if (channels === 3) return 'image/x-rgb';
  if (channels === 4) return 'image/x-rgba';
  return 'application/octet-stream';
}

/**
 * Detect a canonical IANA mime type from a buffer's magic bytes.
 *
 * Used to disambiguate buffers from upstream extractors that don't tell us
 * whether they're raw pixels or an encoded stream. When unpdf returns
 * `channels: 3` plus a buffer that starts with the JPEG SOI marker, the buffer
 * is JPEG and labeling it `image/x-rgb` would mis-route downstream consumers.
 *
 * Returns `undefined` when no signature matches, so callers can fall
 * back to channel-based inference.
 */
export function detectImageMimeFromMagicBytes(
  data: Uint8Array | Buffer,
): PDFImageMimeType | undefined {
  if (data.byteLength < 4) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }

  // TIFF (little-endian): 49 49 2A 00
  // TIFF (big-endian):    4D 4D 00 2A
  if (
    (data[0] === 0x49 &&
      data[1] === 0x49 &&
      data[2] === 0x2a &&
      data[3] === 0x00) ||
    (data[0] === 0x4d &&
      data[1] === 0x4d &&
      data[2] === 0x00 &&
      data[3] === 0x2a)
  ) {
    return 'image/tiff';
  }

  return undefined;
}
