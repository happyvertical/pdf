import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OCROptions } from '@happyvertical/ocr';
import type { ExtractTextOptions, PDFSource } from '../shared/types';
import {
  PDFBatchExtractionError,
  PDFError,
  PDFFileSizeError,
  PDFOCRFallbackError,
} from '../shared/types';

export const DISABLE_CHILD_EXTRACTION_ENV = 'HAVE_PDF_DISABLE_CHILD_EXTRACTION';

const CHILD_WORKER_PATHS = [
  new URL(/* @vite-ignore */ '../node/extract-worker.js', import.meta.url),
  new URL(/* @vite-ignore */ './node/extract-worker.js', import.meta.url),
];
const MAX_CHILD_STDERR_CHARS = 64 * 1024;

type WorkerSourcePayload =
  | { kind: 'path'; path: string }
  | { kind: 'temp-file'; path: string };

interface WorkerReaderOptions {
  ocrProvider?: string;
  defaultOCROptions?: OCROptions;
  maxFileSize?: number;
}

interface WorkerPayload {
  source: WorkerSourcePayload;
  options?: ExtractTextOptions;
  readerOptions: WorkerReaderOptions;
}

type WorkerErrorPayload = {
  name?: string;
  message?: string;
  code?: string;
  pages?: number[];
  actualSizeBytes?: number;
  maxSizeBytes?: number;
};

type WorkerResult =
  | { ok: true; text: string | null }
  | { ok: false; error: WorkerErrorPayload };

export class PDFChildExtractionError extends PDFError {
  constructor(message: string) {
    super(message, 'ECHILD');
    this.name = 'PDFChildExtractionError';
  }
}

function shouldDisableChildExtraction(): boolean {
  const value = process.env[DISABLE_CHILD_EXTRACTION_ENV]?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function canUseChildExtraction(): boolean {
  return !shouldDisableChildExtraction();
}

async function prepareSourcePayload(source: PDFSource): Promise<{
  payload: WorkerSourcePayload;
  cleanup: () => Promise<void>;
}> {
  if (typeof source === 'string') {
    return {
      payload: { kind: 'path', path: source },
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'happyvertical-pdf-child-'));
  const tempFile = join(tempDir, 'source.pdf');
  const data =
    source instanceof ArrayBuffer
      ? Buffer.from(source)
      : Buffer.from(source.buffer, source.byteOffset, source.byteLength);

  try {
    await writeFile(tempFile, data);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    payload: { kind: 'temp-file', path: tempFile },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function resolveChildWorkerPath(): Promise<string> {
  for (const workerUrl of CHILD_WORKER_PATHS) {
    const workerPath = fileURLToPath(workerUrl);
    try {
      await access(workerPath);
      return workerPath;
    } catch {
      // Try the next build layout candidate.
    }
  }

  throw new PDFChildExtractionError(
    `Unable to locate PDF child extraction worker. Checked: ${CHILD_WORKER_PATHS.map((workerUrl) => fileURLToPath(workerUrl)).join(', ')}`,
  );
}

function reviveWorkerError(error: WorkerErrorPayload): Error {
  if (error.name === 'PDFBatchExtractionError' && Array.isArray(error.pages)) {
    return new PDFBatchExtractionError(error.pages, error.message);
  }

  if (error.name === 'PDFOCRFallbackError') {
    return new PDFOCRFallbackError(
      error.message || 'PDF OCR fallback failed',
      error.pages,
    );
  }

  if (
    error.name === 'PDFFileSizeError' &&
    typeof error.actualSizeBytes === 'number' &&
    typeof error.maxSizeBytes === 'number'
  ) {
    return new PDFFileSizeError(error.actualSizeBytes, error.maxSizeBytes);
  }

  if (error.name === 'PDFError') {
    return new PDFError(
      error.message || 'PDF child extraction failed',
      error.code,
    );
  }

  const revived = new Error(error.message || 'PDF child extraction failed');
  revived.name = error.name || 'PDFChildExtractionError';
  return revived;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function appendToDiagnosticTail(
  current: string,
  chunk: string,
  limit = MAX_CHILD_STDERR_CHARS,
): string {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function formatChildStderr(stderr: string, truncated: boolean): string {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return '';
  }

  return truncated ? `[stderr truncated]\n${trimmed}` : trimmed;
}

export async function extractTextInChildProcess(
  source: PDFSource,
  options: ExtractTextOptions | undefined,
  readerOptions: WorkerReaderOptions,
  timeoutMs?: number,
): Promise<string | null> {
  const { payload, cleanup } = await prepareSourcePayload(source);

  try {
    const workerPath = await resolveChildWorkerPath();
    const workerPayload: WorkerPayload = {
      source: payload,
      options,
      readerOptions,
    };

    return await new Promise<string | null>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath], {
        env: {
          ...process.env,
          [DISABLE_CHILD_EXTRACTION_ENV]: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stderrTruncated = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback();
      };

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          child.kill('SIGKILL');
          finish(() =>
            reject(
              new PDFChildExtractionError(
                `PDF child extraction timed out after ${timeoutMs}ms`,
              ),
            ),
          );
        }, timeoutMs);
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderrTruncated =
          stderrTruncated ||
          stderr.length + text.length > MAX_CHILD_STDERR_CHARS;
        stderr = appendToDiagnosticTail(stderr, text);
      });
      child.on('error', (error) => {
        finish(() => reject(error));
      });
      child.stdin.on('error', (error) => {
        finish(() => reject(error));
      });
      child.stdout.on('error', (error) => {
        finish(() => reject(error));
      });
      child.stderr.on('error', (error) => {
        finish(() => reject(error));
      });
      child.on('close', (code, signal) => {
        finish(() => {
          if (code !== 0) {
            const stderrMessage = formatChildStderr(stderr, stderrTruncated);
            reject(
              new PDFChildExtractionError(
                `PDF child extraction exited with ${signal ?? code}${
                  stderrMessage ? `: ${stderrMessage}` : ''
                }`,
              ),
            );
            return;
          }

          let result: WorkerResult;
          try {
            result = JSON.parse(stdout) as WorkerResult;
          } catch (error) {
            const stderrMessage = formatChildStderr(stderr, stderrTruncated);
            reject(
              new PDFChildExtractionError(
                `PDF child extraction returned invalid JSON: ${
                  error instanceof Error ? error.message : String(error)
                }${stderrMessage ? `; stderr: ${stderrMessage}` : ''}`,
              ),
            );
            return;
          }

          if (result.ok) {
            resolve(result.text);
            return;
          }

          reject(reviveWorkerError(result.error));
        });
      });

      try {
        child.stdin.end(JSON.stringify(workerPayload));
      } catch (error) {
        finish(() => reject(toError(error)));
      }
    });
  } finally {
    await cleanup();
  }
}
