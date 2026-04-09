import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPdfOcrRuntimeIssue,
  normalizeTessdataDirectory,
  parseTessdataDirectoryFromTesseractOutput,
} from './ocr-runtime';

const tempDirectories: string[] = [];

describe('OCR Runtime Helpers', () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('should parse tessdata directory from tesseract output', () => {
    const output = `List of available languages in "/usr/share/tessdata/" (2):\neng\nfra\n`;
    expect(parseTessdataDirectoryFromTesseractOutput(output)).toBe(
      '/usr/share/tessdata/',
    );
  });

  it('should normalize a parent directory that contains tessdata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pdf-tessdata-'));
    tempDirectories.push(parent);
    const tessdataDirectory = join(parent, 'tessdata');
    await mkdir(tessdataDirectory);
    await writeFile(join(tessdataDirectory, 'eng.traineddata'), 'stub');

    await expect(normalizeTessdataDirectory(parent)).resolves.toBe(
      tessdataDirectory,
    );
  });

  it('should format missing tessdata errors with actionable guidance', () => {
    const message = formatPdfOcrRuntimeIssue(
      new Error("Failed to initialize language 'eng'"),
      {
        language: 'eng',
        tessdata: {
          checked: ['/usr/share/tessdata'],
          reason: 'Unable to find eng.traineddata',
        },
      },
    );

    expect(message).toContain("Install the 'eng' traineddata package");
    expect(message).toContain('/usr/share/tessdata');
  });

  it('should format pdfjs worker mismatch errors clearly', () => {
    const message = formatPdfOcrRuntimeIssue(
      new Error(
        'The API version "5.4.624" does not match the Worker version "5.4.296".',
      ),
    );

    expect(message).toContain('pdfjs-dist API 5.4.624');
    expect(message).toContain('worker 5.4.296');
    expect(message).toContain('unpdf/pdfjs-dist runtime');
  });

  it('should explain unsupported Kreuzberg OCR backends', () => {
    const message = formatPdfOcrRuntimeIssue(
      new Error("Plugin error in 'onnx': OCR backend 'onnx' not registered"),
      {
        backend: 'onnx',
      },
    );

    expect(message).toContain("Kreuzberg OCR backend 'onnx' is not registered");
    expect(message).toContain("@happyvertical/ocr");
  });
});
