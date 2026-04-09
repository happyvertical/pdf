import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const COMMON_TESSDATA_DIRECTORIES = [
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
  '/usr/local/share/tessdata',
  '/opt/homebrew/share/tessdata',
  '/opt/local/share/tessdata',
];

export interface TessdataResolution {
  checked: string[];
  path?: string;
  reason?: string;
  source?: 'cache' | 'common-path' | 'env' | 'tesseract';
}

const cachedTessdataDirectories = new Map<string, string>();

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseTessdataDirectoryFromTesseractOutput(
  output: string,
): string | null {
  if (!output.trim()) {
    return null;
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines[0];
  if (!firstLine) {
    return null;
  }

  const quotedMatch = firstLine.match(/List of available languages in "(.+?)"/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  if (firstLine.startsWith('/') || /^[A-Za-z]:[\\/]/.test(firstLine)) {
    return firstLine;
  }

  return null;
}

export async function normalizeTessdataDirectory(
  candidate: string | null | undefined,
  language = 'eng',
): Promise<string | null> {
  if (!candidate?.trim()) {
    return null;
  }

  const trimmed = candidate.trim().replace(/^['"]|['"]$/g, '');
  const candidates = [trimmed, join(trimmed, 'tessdata')];

  for (const directory of candidates) {
    const traineddataPath = join(directory, `${language}.traineddata`);
    if (await isReadableFile(traineddataPath)) {
      return directory;
    }
  }

  return null;
}

async function resolveTessdataFromTesseractBinary(
  language: string,
  checked: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFile('tesseract', ['--list-langs'], {
      env: process.env,
      timeout: 5000,
    });
    const candidate = parseTessdataDirectoryFromTesseractOutput(stdout);
    if (candidate) {
      checked.push(candidate);
      return normalizeTessdataDirectory(candidate, language);
    }
  } catch {
    // Ignore subprocess errors and fall back to common install locations.
  }

  return null;
}

export async function ensureTessdataPrefix(
  language = 'eng',
): Promise<TessdataResolution> {
  const checked: string[] = [];
  const cachedTessdataDirectory = cachedTessdataDirectories.get(language);

  if (cachedTessdataDirectory) {
    const normalized = await normalizeTessdataDirectory(
      cachedTessdataDirectory,
      language,
    );
    if (normalized) {
      process.env.TESSDATA_PREFIX = normalized;
      return {
        checked,
        path: normalized,
        source: 'cache',
      };
    }

    cachedTessdataDirectories.delete(language);
  }

  const envCandidate = process.env.TESSDATA_PREFIX;
  if (envCandidate) {
    checked.push(envCandidate);
    const normalized = await normalizeTessdataDirectory(envCandidate, language);
    if (normalized) {
      cachedTessdataDirectories.set(language, normalized);
      process.env.TESSDATA_PREFIX = normalized;
      return {
        checked,
        path: normalized,
        source: 'env',
      };
    }
  }

  const fromTesseract = await resolveTessdataFromTesseractBinary(
    language,
    checked,
  );
  if (fromTesseract) {
    cachedTessdataDirectories.set(language, fromTesseract);
    process.env.TESSDATA_PREFIX = fromTesseract;
    return {
      checked,
      path: fromTesseract,
      source: 'tesseract',
    };
  }

  for (const directory of COMMON_TESSDATA_DIRECTORIES) {
    checked.push(directory);
    const normalized = await normalizeTessdataDirectory(directory, language);
    if (normalized) {
      cachedTessdataDirectories.set(language, normalized);
      process.env.TESSDATA_PREFIX = normalized;
      return {
        checked,
        path: normalized,
        source: 'common-path',
      };
    }
  }

  return {
    checked,
    reason: `Unable to find ${language}.traineddata`,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function formatPdfOcrRuntimeIssue(
  error: unknown,
  context: {
    backend?: string;
    language?: string;
    tessdata?: TessdataResolution | null;
  } = {},
): string {
  const message = getErrorMessage(error);

  if (
    /Failed to initialize language|TESSDATA_PREFIX|traineddata|Tesseract couldn't load any languages/i.test(
      message,
    )
  ) {
    const language = context.language || 'eng';
    const tessdata = context.tessdata;
    const detectedPath = tessdata?.path
      ? ` Auto-detected tessdata path: ${tessdata.path}.`
      : '';
    const checkedPaths =
      tessdata?.checked?.length && !tessdata?.path
        ? ` Checked: ${tessdata.checked.join(', ')}.`
        : '';

    return `Kreuzberg could not initialize Tesseract language '${language}'. Install the '${language}' traineddata package and point TESSDATA_PREFIX at the tessdata directory.${detectedPath}${checkedPaths} Original error: ${message}`;
  }

  const versionMismatchMatch = message.match(
    /API version "([^"]+)" does not match the Worker version "([^"]+)"/i,
  );
  if (versionMismatchMatch) {
    const [, apiVersion, workerVersion] = versionMismatchMatch;
    return `PDF page rendering failed because pdfjs-dist API ${apiVersion} does not match worker ${workerVersion}. Ensure the installed @happyvertical/pdf and unpdf/pdfjs-dist runtime resolve compatible pdfjs-dist builds. Original error: ${message}`;
  }

  const backendMatch = message.match(
    /OCR backend ['"]([^'"]+)['"] not registered/i,
  );
  if (backendMatch) {
    const backend = context.backend || backendMatch[1];
    return `Kreuzberg OCR backend '${backend}' is not registered in this runtime. Use the built-in 'tesseract' backend, or route OCR through @happyvertical/ocr for providers like 'onnx'. Original error: ${message}`;
  }

  if (/libonnxruntime|ONNX Runtime dylib/i.test(message)) {
    return `The requested ONNX OCR runtime is missing its native library. Install the ONNX runtime for the target image, or use the @happyvertical/ocr 'onnx' provider instead of a Kreuzberg backend. Original error: ${message}`;
  }

  return message;
}
