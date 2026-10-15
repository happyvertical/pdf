import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaddleOCRClient } from './paddleocr';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, stat: vi.fn(fs.stat), readFile: vi.fn(fs.readFile) };
});

const pdf = Buffer.from('%PDF-1.7\nfixture');
const envelope = () => ({
  errorCode: 0,
  logId: 'request-1',
  result: {
    dataInfo: { numPages: 2 },
    layoutParsingResults: [
      {
        markdown: { text: '# Page one', images: { 'figure.png': 'aW1hZ2U=' } },
        prunedResult: {
          parsing_res_list: [
            { block_label: 'future-label', block_bbox: [1, 2, 3, 4] },
          ],
        },
      },
      {
        markdown: { text: '| Table |\n|---|', images: null },
        prunedResult: {},
      },
    ],
  },
});
let server: Server;
let baseUrl: string;
let calls: { url: string; body: unknown; auth?: string }[];
let respond: (res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  calls = [];
  respond = (res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(envelope()));
  };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      url: req.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString()),
      auth: req.headers.authorization,
    });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PaddleOCR full pipeline client', () => {
  it('posts the exact byte view and preserves ordered Markdown, layout and optional images', async () => {
    const padded = Buffer.concat([
      Buffer.from('junk'),
      pdf,
      Buffer.from('trailing'),
    ]);
    const view = new Uint8Array(
      padded.buffer,
      padded.byteOffset + 4,
      pdf.length,
    );
    const result = await new PaddleOCRClient({
      baseUrl: `${baseUrl}/parser/`,
      apiKey: 'test-key',
    }).parse(view, { returnMarkdownImages: true });
    expect(calls).toEqual([
      {
        url: '/parser/layout-parsing',
        auth: 'Bearer test-key',
        body: {
          file: pdf.toString('base64'),
          fileType: 0,
          useLayoutDetection: true,
          visualize: false,
          returnMarkdownImages: true,
        },
      },
    ]);
    expect(result.markdown).toBe('# Page one\n\n| Table |\n|---|');
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0].layout).toEqual(
      envelope().result.layoutParsingResults[0].prunedResult,
    );
    expect(result.pages[0].images).toEqual({ 'figure.png': 'aW1hZ2U=' });
    expect(result.pages[1].images).toBeUndefined();
    expect(result.dataInfo).toEqual({ numPages: 2 });
    expect(result.logId).toBe('request-1');
  });

  it('accepts local files and ArrayBuffers; reads endpoint/token from env with explicit precedence', async () => {
    vi.stubEnv('HAVE_PDF_PADDLEOCR_URL', baseUrl);
    vi.stubEnv('HAVE_PDF_PADDLEOCR_API_KEY', 'env-key');
    const dir = await mkdtemp(join(tmpdir(), 'paddle-client-'));
    try {
      const path = join(dir, 'document.pdf');
      await writeFile(path, pdf);
      await new PaddleOCRClient().parse(path);
      await new PaddleOCRClient({ baseUrl, apiKey: '' }).parse(
        Uint8Array.from(pdf).buffer,
      );
      expect(calls[0].auth).toBe('Bearer env-key');
      expect(calls[1].auth).toBeUndefined();
      expect(calls[1].body).toMatchObject({
        returnMarkdownImages: false,
        file: pdf.toString('base64'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed inputs, unreadable paths and oversized bytes/files before submission', async () => {
    const client = new PaddleOCRClient({ baseUrl, maxFileSize: 10 });
    await expect(client.parse(pdf)).rejects.toMatchObject({ code: 'EMAXFILE' });
    await expect(client.parse(Buffer.from('bad'))).rejects.toMatchObject({
      code: 'EINVAL',
    });
    await expect(
      client.parse('/nonexistent/private-file.pdf'),
    ).rejects.toMatchObject({ code: 'EPADDLEIO' });
    const dir = await mkdtemp(join(tmpdir(), 'paddle-size-'));
    try {
      const path = join(dir, 'large.pdf');
      await writeFile(path, pdf);
      await expect(client.parse(path)).rejects.toMatchObject({
        code: 'EMAXFILE',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    {},
    { errorCode: 0 },
    { errorCode: 0, result: { layoutParsingResults: [null] } },
    {
      errorCode: 0,
      result: {
        layoutParsingResults: [{ markdown: { text: 1 }, prunedResult: {} }],
      },
    },
    {
      errorCode: 0,
      result: {
        layoutParsingResults: [
          { markdown: { text: '', images: { x: 1 } }, prunedResult: {} },
        ],
      },
    },
  ])('rejects malformed response %#', async (body) => {
    respond = (res) => res.end(JSON.stringify(body));
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf),
    ).rejects.toMatchObject({ code: 'EPADDLERESPONSE' });
  });

  it('accepts missing optional metadata and empty results', async () => {
    respond = (res) =>
      res.end(
        JSON.stringify({
          errorCode: 0,
          result: { layoutParsingResults: [] },
          futureField: 'ignored',
        }),
      );
    await expect(new PaddleOCRClient({ baseUrl }).parse(pdf)).resolves.toEqual({
      markdown: '',
      pages: [],
    });
  });

  it('reports HTTP and API errors without exposing upstream bodies and never retries', async () => {
    respond = (res) => {
      res.statusCode = 503;
      res.end('secret document');
    };
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf),
    ).rejects.toMatchObject({ code: 'EPADDLEHTTP', status: 503 });
    expect(calls).toHaveLength(1);
    respond = (res) =>
      res.end(JSON.stringify({ errorCode: 500, errorMsg: 'secret document' }));
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf),
    ).rejects.toMatchObject({
      code: 'EPADDLEAPI',
      message: 'PaddleOCR reported a parsing failure',
    });
  });

  it('rejects redirects, malformed JSON and network failures', async () => {
    respond = (res) => {
      res.writeHead(307, { Location: `${baseUrl}/elsewhere` });
      res.end();
    };
    await expect(
      new PaddleOCRClient({ baseUrl, apiKey: 'private' }).parse(pdf),
    ).rejects.toMatchObject({ code: 'EPADDLEIO' });
    expect(calls).toHaveLength(1);
    respond = (res) => res.end('<html>gateway error</html>');
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf),
    ).rejects.toMatchObject({ code: 'EPADDLERESPONSE' });
    respond = (res) => res.destroy();
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf),
    ).rejects.toMatchObject({ code: 'EPADDLEIO' });
  });

  it('cancels pending requests and includes response-body time in the deadline', async () => {
    respond = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    };
    await expect(
      new PaddleOCRClient({ baseUrl, timeout: 40 }).parse(pdf),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const controller = new AbortController();
    const pending = new PaddleOCRClient({ baseUrl }).parse(pdf, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'EABORT' });
    const count = calls.length;
    await expect(
      new PaddleOCRClient({ baseUrl }).parse(pdf, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'EABORT' });
    expect(calls).toHaveLength(count);
  });

  it('enforces deadlines while metadata is stalled and handles late rejection', async () => {
    let rejectStat!: (reason: Error) => void;
    vi.mocked(stat).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStat = reject;
        }),
    );
    await expect(
      new PaddleOCRClient({ baseUrl, timeout: 30 }).parse('/stalled.pdf'),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    rejectStat(new Error('late filesystem failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
  });

  it('honors caller cancellation during a stalled metadata lookup', async () => {
    vi.mocked(stat).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = new PaddleOCRClient({ baseUrl }).parse('/stalled.pdf', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'EABORT' });
    expect(calls).toHaveLength(0);
  });

  it('enforces the deadline when file reading never settles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paddle-stalled-'));
    try {
      const path = join(dir, 'document.pdf');
      await writeFile(path, pdf);
      vi.mocked(readFile).mockImplementationOnce(() => new Promise(() => {}));
      await expect(
        new PaddleOCRClient({ baseUrl, timeout: 30 }).parse(path),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(calls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates configuration without echoing credentials', () => {
    vi.stubEnv('HAVE_PDF_PADDLEOCR_URL', '');
    expect(() => new PaddleOCRClient()).toThrow();
    for (const url of [
      'file:///etc/passwd',
      'http://user:secret@localhost',
      'http://localhost?a=1',
      'invalid',
    ]) {
      expect(() => new PaddleOCRClient({ baseUrl: url })).toThrow(/HTTP\(S\)/);
    }
    for (const timeout of [0, -1, NaN, Infinity, 2 ** 32])
      expect(() => new PaddleOCRClient({ baseUrl, timeout })).toThrow();
    for (const maxFileSize of [0, -1, NaN, Infinity])
      expect(() => new PaddleOCRClient({ baseUrl, maxFileSize })).toThrow();
  });
});
