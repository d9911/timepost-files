import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
test('PWA кэширует оболочку и не перехватывает приватные запросы', async () => {
  const source = (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')).replace(
    'export {};',
    '',
  );
  class WorkerRequest extends Request {
    constructor(input: string, options?: RequestInit) {
      super(new URL(input, 'https://files.test'), options);
    }
  }
  const listeners = new Map<string, (event: unknown) => void>();
  const store = new Map<string, Response>();
  let added: Request[] = [];
  const removed: string[] = [];
  let claimed = false;
  const cache = {
    addAll: async (requests: Request[]) => {
      added = requests;
    },
    match: async (path: string) => store.get(path),
  };
  runInNewContext(source, {
    Request: WorkerRequest,
    Response,
    URL,
    location: { origin: 'https://files.test' },
    clients: {
      claim: async () => {
        claimed = true;
      },
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    caches: {
      open: async () => cache,
      keys: async () => ['timepost-files-shell-old', 'other-application'],
      delete: async (name: string) => {
        removed.push(name);
      },
    },
    fetch: async () => new Response('network'),
  });
  let waiting: Promise<unknown> | undefined;
  listeners.get('install')!({
    waitUntil: (p: Promise<unknown>) => {
      waiting = p;
    },
  });
  await waiting;
  assert.ok(added.some((r) => new URL(r.url).pathname === '/app.js'));
  assert.ok(added.every((r) => !r.url.includes('/api/') && r.credentials === 'omit'));
  listeners.get('activate')!({
    waitUntil: (p: Promise<unknown>) => {
      waiting = p;
    },
  });
  await waiting;
  assert.deepEqual(removed, ['timepost-files-shell-old']);
  assert.equal(claimed, true);
  const intercepted = (request: Request) => {
    let result: Promise<Response> | undefined;
    listeners.get('fetch')!({
      request,
      respondWith: (p: Promise<Response>) => {
        result = p;
      },
    });
    return result;
  };
  for (const request of [
    new Request('https://files.test/api/v1/files'),
    new Request('https://files.test/api/v1/files/id/content'),
    new Request('https://files.test/', { headers: { Authorization: 'Bearer private' } }),
    new Request('https://files.test/?token=private'),
    new Request('https://other.test/style.css'),
    new Request('https://files.test/', { method: 'POST' }),
  ])
    assert.equal(intercepted(request), undefined);
  store.set('/style.css', new Response('cached stylesheet'));
  assert.equal(
    await (await intercepted(new Request('https://files.test/style.css'))!).text(),
    'cached stylesheet',
  );
});
