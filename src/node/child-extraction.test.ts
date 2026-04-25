import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendToDiagnosticTail,
  extractTextInChildProcess,
} from './child-extraction';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    access: vi.fn(async () => undefined),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

type FakeChildProcess = EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  stdinPayload?: string;
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;

  child.stdin = new EventEmitter() as FakeChildProcess['stdin'];
  child.stdout = new EventEmitter() as FakeChildProcess['stdout'];
  child.stderr = new EventEmitter() as FakeChildProcess['stderr'];
  child.kill = vi.fn();
  child.stdin.end = vi.fn((payload: string) => {
    child.stdinPayload = payload;
  });
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();

  return child;
}

async function expectTempDirRemoved(path: string): Promise<void> {
  const actualFs =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );

  await expect(actualFs.stat(dirname(path))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

describe('child extraction diagnostics', () => {
  it('keeps only the diagnostic tail when child stderr is noisy', () => {
    let stderr = appendToDiagnosticTail('', '0123456789', 12);
    stderr = appendToDiagnosticTail(stderr, 'abcdef', 12);

    expect(stderr).toBe('456789abcdef');
  });
});

describe('extractTextInChildProcess', () => {
  beforeEach(() => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.rm).mockImplementation(async (...args) => {
      const actualFs =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      return actualFs.rm(...args);
    });
    vi.mocked(fsPromises.writeFile).mockImplementation(async (...args) => {
      const actualFs =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      return actualFs.writeFile(...args);
    });
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns worker text and removes the temp source file on success', async () => {
    const child = createFakeChildProcess();
    child.stdin.end.mockImplementation((payload: string) => {
      child.stdinPayload = payload;
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          JSON.stringify({ ok: true, text: 'worker text' }),
        );
        child.emit('close', 0, null);
      });
    });
    spawnMock.mockReturnValue(child);

    await expect(
      extractTextInChildProcess(
        new Uint8Array([37, 80, 68, 70]),
        { mergePages: true },
        { ocrProvider: 'auto' },
      ),
    ).resolves.toBe('worker text');

    const payload = JSON.parse(child.stdinPayload || '{}');
    expect(payload.source.kind).toBe('temp-file');
    expect(payload.options).toMatchObject({ mergePages: true });
    expect(payload.readerOptions).toMatchObject({ ocrProvider: 'auto' });
    await expectTempDirRemoved(payload.source.path);
  });

  it('rejects invalid worker JSON and removes the temp source file', async () => {
    const child = createFakeChildProcess();
    child.stdin.end.mockImplementation((payload: string) => {
      child.stdinPayload = payload;
      queueMicrotask(() => {
        child.stderr.emit('data', 'worker warning');
        child.stdout.emit('data', 'not json');
        child.emit('close', 0, null);
      });
    });
    spawnMock.mockReturnValue(child);

    await expect(
      extractTextInChildProcess(new Uint8Array([1, 2, 3]), undefined, {}),
    ).rejects.toThrow('PDF child extraction returned invalid JSON');

    const payload = JSON.parse(child.stdinPayload || '{}');
    await expectTempDirRemoved(payload.source.path);
  });

  it('rejects child stdio errors instead of hanging', async () => {
    const child = createFakeChildProcess();
    child.stdin.end.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('error', new Error('stdout broke'));
      });
    });
    spawnMock.mockReturnValue(child);

    await expect(
      extractTextInChildProcess('/tmp/source.pdf', undefined, {}),
    ).rejects.toThrow('stdout broke');
  });

  it('kills the child on timeout and removes the temp source file', async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);

    await expect(
      extractTextInChildProcess(new Uint8Array([1, 2, 3]), undefined, {}, 1),
    ).rejects.toThrow('PDF child extraction timed out after 1ms');

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const payload = JSON.parse(child.stdinPayload || '{}');
    await expectTempDirRemoved(payload.source.path);
  });

  it('removes the temp directory if writing a buffer source fails', async () => {
    vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(
      new Error('disk full'),
    );

    await expect(
      extractTextInChildProcess(new Uint8Array([1, 2, 3]), undefined, {}),
    ).rejects.toThrow('disk full');

    expect(fsPromises.rm).toHaveBeenCalledWith(
      expect.stringContaining('happyvertical-pdf-child-'),
      { recursive: true, force: true },
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
