/**
 * @happyvertical/pdf - Canonical image format normalization (browser-safe).
 *
 * Issue #74: producer-side `format` values vary wildly (`'rgb'`, `'image/jpg'`,
 * `'image/x-png'`, `'application/octet-stream'`, etc.). This module returns
 * the canonical lowercase IANA mime type so consumers don't all reinvent the
 * same normalizer.
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
    default:
      // Fall through to channel inference for unknown / empty labels.
      break;
  }

  if (channels === 1) return 'image/x-grayscale';
  if (channels === 3) return 'image/x-rgb';
  if (channels === 4) return 'image/x-rgba';
  return 'application/octet-stream';
}
