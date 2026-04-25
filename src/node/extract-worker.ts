import type { ExtractTextOptions } from '../shared/types';
import { CombinedNodeProvider } from './combined';

function writeLogToStderr(level: string, args: unknown[]): void {
  const line = args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  process.stderr.write(`[${level}] ${line}\n`);
}

console.log = (...args: unknown[]) => writeLogToStderr('log', args);
console.warn = (...args: unknown[]) => writeLogToStderr('warn', args);
console.error = (...args: unknown[]) => writeLogToStderr('error', args);

interface WorkerPayload {
  source: { kind: 'path' | 'temp-file'; path: string };
  options?: Record<string, unknown>;
  readerOptions?: Record<string, unknown>;
}

type WorkerReaderOptions = ConstructorParameters<
  typeof CombinedNodeProvider
>[0];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: 'Error',
      message: String(error),
    };
  }

  const payload: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  const maybePdfError = error as Error & {
    code?: string;
    pages?: number[];
    actualSizeBytes?: number;
    maxSizeBytes?: number;
  };

  if (maybePdfError.code) payload.code = maybePdfError.code;
  if (maybePdfError.pages) payload.pages = maybePdfError.pages;
  if (maybePdfError.actualSizeBytes !== undefined) {
    payload.actualSizeBytes = maybePdfError.actualSizeBytes;
  }
  if (maybePdfError.maxSizeBytes !== undefined) {
    payload.maxSizeBytes = maybePdfError.maxSizeBytes;
  }

  return payload;
}

try {
  const payload = JSON.parse(await readStdin()) as WorkerPayload;
  const reader = new CombinedNodeProvider(
    (payload.readerOptions ?? {}) as WorkerReaderOptions,
  );
  const text = await reader.extractText(
    payload.source.path,
    payload.options as ExtractTextOptions | undefined,
  );
  process.stdout.write(JSON.stringify({ ok: true, text }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: serializeError(error),
    }),
  );
}
