import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import {
  decodePDFRawStream,
  type PDFArray,
  PDFDocument,
  type PDFRawStream,
  type PDFRef,
} from 'pdf-lib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  getPDFReader,
  imagesToPdf,
  PDFGenerationError,
  PDFImageCorruptError,
  PDFImageLimitExceededError,
  PDFImageUnsupportedTypeError,
} from '../index';
import { orientationMatrix } from './images-to-pdf';

/** Solid-colour test image of the given pixel size. */
function make(
  kind: 'png' | 'jpeg' | 'webp',
  w: number,
  h: number,
  alpha = false,
): Buffer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  if (!alpha || kind !== 'png') {
    g.fillStyle = '#c04020';
    g.fillRect(0, 0, w, h);
  } else {
    g.fillStyle = 'rgba(0, 0, 255, 0.5)';
    g.fillRect(0, 0, w / 2, h);
  }
  return c.toBuffer(`image/${kind}` as 'image/png');
}

/** Insert an EXIF APP1 segment carrying only an orientation tag. */
function withOrientation(
  jpeg: Buffer,
  orientation: number,
  le = false,
): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(le ? 'II' : 'MM', 0, 'ascii');
  const w16 = (o: number, v: number) =>
    le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o);
  w16(2, 0x2a);
  if (le) tiff.writeUInt32LE(8, 4);
  else tiff.writeUInt32BE(8, 4);
  w16(8, 1);
  w16(10, 0x0112);
  w16(12, 3);
  if (le) tiff.writeUInt32LE(1, 14);
  else tiff.writeUInt32BE(1, 14);
  w16(18, orientation);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}

async function pages(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => p.getSize());
}

const FIXED = new Date('2026-01-02T03:04:05Z');

describe('imagesToPdf', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('puts one image per page in the given order and reopens with the package reader', async () => {
    const pdf = await imagesToPdf(
      [make('png', 100, 50), make('jpeg', 60, 120), make('png', 30, 30)],
      { dpi: 72 },
    );
    expect(await pages(pdf)).toEqual([
      { width: 100, height: 50 },
      { width: 60, height: 120 },
      { width: 30, height: 30 },
    ]);
  });

  it("'image' mode sizes the page from pixels and dpi, plus margin", async () => {
    const png = make('png', 300, 150);
    expect(await pages(await imagesToPdf([png]))).toEqual([
      { width: 144, height: 72 }, // default 150 dpi
    ]);
    expect(
      await pages(await imagesToPdf([png], { dpi: 300, margin: 10 })),
    ).toEqual([{ width: 92, height: 56 }]);
  });

  it('accepts Uint8Array and file paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img2pdf-'));
    dirs.push(dir);
    const file = join(dir, 'x.dat'); // name is irrelevant: type is by signature
    await writeFile(file, make('jpeg', 40, 40));
    const pdf = await imagesToPdf([new Uint8Array(make('png', 10, 10)), file]);
    expect((await pages(pdf)).length).toBe(2);
  });

  it('named sizes pick orientation per image in auto mode', async () => {
    const pdf = await imagesToPdf(
      [make('png', 200, 100), make('png', 100, 200), make('png', 100, 100)],
      { pageSize: 'letter' },
    );
    expect(await pages(pdf)).toEqual([
      { width: 792, height: 612 },
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]);
    const forced = await imagesToPdf([make('png', 200, 100)], {
      pageSize: { width: 300, height: 400 },
      orientation: 'portrait',
    });
    expect(await pages(forced)).toEqual([{ width: 300, height: 400 }]);
    const a4 = await imagesToPdf([make('png', 5, 5)], {
      pageSize: 'a4',
      orientation: 'landscape',
    });
    expect((await pages(a4))[0].width).toBeCloseTo(841.89);
  });

  it('EXIF orientation swaps the page shape for 6 and 8, not 1 and 3', async () => {
    const base = make('jpeg', 200, 100);
    const sizes: Record<number, { width: number; height: number }> = {};
    for (const o of [1, 3, 6, 8]) {
      sizes[o] = (
        await pages(await imagesToPdf([withOrientation(base, o)], { dpi: 72 }))
      )[0];
    }
    expect(sizes[1]).toEqual({ width: 200, height: 100 });
    expect(sizes[3]).toEqual({ width: 200, height: 100 });
    expect(sizes[6]).toEqual({ width: 100, height: 200 });
    expect(sizes[8]).toEqual({ width: 100, height: 200 });
    // little-endian EXIF is read too
    const le = await imagesToPdf([withOrientation(base, 6, true)], { dpi: 72 });
    expect((await pages(le))[0]).toEqual({ width: 100, height: 200 });
  });

  it('orientation matrices map the stored corners to the upright corners', () => {
    // Apply the matrix to stored corners (u,v): v=1 is the stored top row.
    const map = (o: number, u: number, v: number) => {
      const [a, b, c, d, e, f] = orientationMatrix(o, 0, 0, 1, 1);
      return [a * u + c * v + e, b * u + d * v + f];
    };
    // stored top-left -> upright position, per EXIF spec
    expect(map(1, 0, 1)).toEqual([0, 1]); // top-left
    expect(map(3, 0, 1)).toEqual([1, 0]); // bottom-right
    expect(map(6, 0, 1)).toEqual([1, 1]); // top-right (rotate 90 cw)
    expect(map(8, 0, 1)).toEqual([0, 0]); // bottom-left (rotate 90 ccw)
    // stored top-right
    expect(map(6, 1, 1)).toEqual([1, 0]);
    expect(map(8, 1, 1)).toEqual([0, 1]);
  });

  it('contain and cover scale to the area inside the margin', async () => {
    const png = make('png', 200, 100);
    const render = async (fit: 'contain' | 'cover') => {
      const pdf = await imagesToPdf([png], {
        pageSize: { width: 100, height: 100 },
        fit,
        margin: 10,
        creationDate: FIXED,
      });
      const doc = await PDFDocument.load(pdf);
      const page = doc.getPage(0);
      const arr = page.node.Contents() as PDFArray;
      const raw = arr
        .asArray()
        .map((ref) =>
          Buffer.from(
            decodePDFRawStream(
              doc.context.lookup(ref as PDFRef) as PDFRawStream,
            ).decode(),
          ).toString('latin1'),
        )
        .join('\n');
      return raw;
    };
    const contain = await render('contain');
    const cover = await render('cover');
    // contain: 80 wide, 40 high, centred at (10, 30)
    expect(contain).toMatch(/80 0 0 40 10 30 cm/);
    expect(contain).not.toContain(' W');
    // cover: 160 wide, 80 high, centred at (-30, 10); clipped to the margin box
    expect(cover).toMatch(/160 0 0 80 -30 10 cm/);
    expect(cover).toMatch(/10 10 80 80 re\s+W\s+n/);
  });

  it('embeds PNG with alpha', async () => {
    const pdf = await imagesToPdf([make('png', 20, 20, true)], { dpi: 72 });
    expect(await pages(pdf)).toEqual([{ width: 20, height: 20 }]);
    expect(Buffer.from(pdf).toString('latin1')).toContain('/SMask');
  });

  it('refuses WebP with a typed error and never decodes it', async () => {
    const webp = make('webp', 64, 32);
    await expect(imagesToPdf([webp])).rejects.toBeInstanceOf(
      PDFImageUnsupportedTypeError,
    );
    // damaged WebP is refused by signature too, so it cannot hang a decoder
    const damaged = Buffer.from(webp);
    for (let i = 24; i < damaged.length; i += 5) damaged[i] ^= 0x5a;
    await expect(imagesToPdf([damaged])).rejects.toBeInstanceOf(
      PDFImageUnsupportedTypeError,
    );
  });

  it('rejects unsupported types by signature, not by name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img2pdf-'));
    dirs.push(dir);
    const gif = join(dir, 'photo.png');
    await writeFile(
      gif,
      Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'),
    );
    await expect(imagesToPdf([make('png', 4, 4), gif])).rejects.toMatchObject({
      name: 'PDFImageUnsupportedTypeError',
      index: 1,
    });
    await expect(imagesToPdf([Buffer.alloc(0)])).rejects.toBeInstanceOf(
      PDFImageUnsupportedTypeError,
    );
    await expect(
      imagesToPdf(['/definitely/not/here.png']),
    ).rejects.toBeInstanceOf(PDFImageCorruptError);
  });

  it('rejects corrupt and truncated images quickly, without leaking contents', async () => {
    const png = make('png', 50, 50);
    const jpeg = make('jpeg', 50, 50);
    const bad: Buffer[] = [
      png.subarray(0, png.length - 20), // truncated PNG (no IEND)
      png.subarray(0, 20),
      jpeg.subarray(0, Math.floor(jpeg.length / 2)), // truncated JPEG
      Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(30, 0xff)]),
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x03]),
        Buffer.alloc(8),
      ]),
    ];
    const t = Date.now();
    for (const b of bad) {
      const err = await imagesToPdf([b]).catch((e) => e);
      expect(err).toBeInstanceOf(PDFImageCorruptError);
      expect(err.index).toBe(0);
      expect(err.message).toMatch(/^[\x20-\x7e]{1,80}$/);
    }
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it('rejects a PNG whose IDAT stream is damaged', async () => {
    const png = Buffer.from(make('png', 40, 40));
    const at = png.indexOf('IDAT') + 8;
    for (let i = at; i < at + 16; i++) png[i] = 0xaa;
    await expect(imagesToPdf([png])).rejects.toBeInstanceOf(
      PDFImageCorruptError,
    );
  });

  it('survives seeded byte-flip fuzzing of PNG and JPEG with only typed errors', async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const t = Date.now();
    for (const base of [make('png', 32, 32), make('jpeg', 32, 32)]) {
      for (let n = 0; n < 300; n++) {
        const b = Buffer.from(base);
        for (let j = 0, k = 1 + Math.floor(rnd() * 4); j < k; j++) {
          b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
        }
        const cut =
          rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
        await imagesToPdf([cut]).catch((e) => {
          expect(e.name).toMatch(
            /^PDFImage(Corrupt|Unsupported|LimitExceeded)/,
          );
        });
      }
    }
    expect(Date.now() - t).toBeLessThan(30_000);
  });

  it('enforces each limit with a typed error', async () => {
    const png = make('png', 40, 40);
    const e1 = await imagesToPdf([png, png, png], { maxImages: 2 }).catch(
      (e) => e,
    );
    expect(e1).toBeInstanceOf(PDFImageLimitExceededError);
    expect(e1.limit).toBe('maxImages');
    const e2 = await imagesToPdf([png], { maxImageBytes: 10 }).catch((e) => e);
    expect(e2).toMatchObject({ limit: 'maxImageBytes', index: 0 });
    const e3 = await imagesToPdf([png, png], {
      maxTotalBytes: png.length + 1,
    }).catch((e) => e);
    expect(e3).toMatchObject({ limit: 'maxTotalBytes', index: 1 });
    const e4 = await imagesToPdf([png], { maxImagePixels: 1599 }).catch(
      (e) => e,
    );
    expect(e4).toMatchObject({ limit: 'maxImagePixels', index: 0 });
    // a huge declared size is refused before any decode
    const huge = Buffer.from(png);
    huge.writeUInt32BE(60000, 16);
    huge.writeUInt32BE(60000, 20);
    huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29); // keep the CRC valid
    const e6 = await imagesToPdf([huge]).catch((e) => e);
    expect(e6).toMatchObject({ limit: 'maxImagePixels' });
  });

  it('validates options and the image list', async () => {
    const png = make('png', 4, 4);
    await expect(imagesToPdf([])).rejects.toBeInstanceOf(PDFGenerationError);
    await expect(
      imagesToPdf([png], { pageSize: 'toString' as 'a4' }),
    ).rejects.toBeInstanceOf(PDFGenerationError);
    await expect(imagesToPdf([png], { dpi: 0 })).rejects.toBeInstanceOf(
      PDFGenerationError,
    );
    await expect(imagesToPdf([png], { margin: -1 })).rejects.toBeInstanceOf(
      PDFGenerationError,
    );
    await expect(imagesToPdf([png], { maxImages: 0 })).rejects.toBeInstanceOf(
      PDFGenerationError,
    );
    await expect(
      imagesToPdf([png], { pageSize: 'letter', margin: 400 }),
    ).rejects.toBeInstanceOf(PDFGenerationError);
  });

  it('is byte-identical for identical inputs and date, and sets metadata', async () => {
    const inputs = [
      make('png', 30, 20),
      withOrientation(make('jpeg', 30, 20), 6),
    ];
    const opts = { title: 'Mill cert', creationDate: FIXED };
    const a = await imagesToPdf(inputs, opts);
    const b = await imagesToPdf(inputs, opts);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const doc = await PDFDocument.load(a);
    expect(doc.getTitle()).toBe('Mill cert');
    expect(doc.getCreationDate()?.toISOString()).toBe(FIXED.toISOString());
  });

  it('needs no browser: puppeteer-core is never imported and Chromium may be absent', async () => {
    vi.resetModules();
    vi.stubEnv('PUPPETEER_EXECUTABLE_PATH', '/nonexistent/chromium');
    vi.doMock('puppeteer-core', () => {
      throw new Error('puppeteer-core must not be imported by imagesToPdf');
    });
    try {
      const mod = await import('../index');
      const pdf = await mod.imagesToPdf([
        make('png', 10, 10),
        make('jpeg', 10, 10),
      ]);
      expect((await pages(pdf)).length).toBe(2);
    } finally {
      vi.doUnmock('puppeteer-core');
      vi.unstubAllEnvs();
    }
  });

  it('output re-opens with the package PDF reader and reports the page count', async () => {
    const pdf = await imagesToPdf([make('png', 10, 10), make('jpeg', 10, 10)]);
    const reader = await getPDFReader({ provider: 'unpdf' });
    const info = await reader.getInfo(pdf);
    expect(info.pageCount).toBe(2);
  });
});
