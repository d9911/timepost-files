import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const context = new AsyncLocalStorage<{ requestId: string; startedAt: number }>();
export function requestId() {
  return context.getStore()?.requestId;
}
export function requestTiming() {
  return `app;dur=${(performance.now() - (context.getStore()?.startedAt ?? performance.now())).toFixed(2)}`;
}
export function withRequestContext(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const candidate = request.headers['x-request-id'];
    const id =
      typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(candidate)
        ? candidate
        : randomUUID();
    const startedAt = performance.now();
    response.setHeader('X-Request-Id', id);
    response.on('finish', () => {
      if (process.env.HTTP_REQUEST_LOG_ENABLED !== 'true') return;
      // Лог не содержит токены, имена файлов, пользовательские идентификаторы и query.
      const path = (request.url ?? '').split('?')[0] ?? '';
      const route = path.replace(/\/files\/[^/]+/, '/files/:id');
      const known =
        /^\/(health\/ready|api\/v1\/(storage|files(?:\/?:id(?:\/(content|deletion|thumbnail))?)?|internal\/file-references))$/.test(
          route,
        );
      console.info(
        JSON.stringify({
          event: 'http_request',
          service: 'files',
          requestId: id,
          method: request.method,
          route: known ? route : 'unmatched',
          status: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        }),
      );
    });
    return context.run({ requestId: id, startedAt }, () => handler(request, response));
  };
}
