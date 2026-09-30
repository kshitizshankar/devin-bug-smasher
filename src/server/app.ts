import { open, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isLoopbackHost } from '../config/settings.ts';
import type { DashboardApi } from '../dashboard/dashboard.ts';

export interface AppOptions {
  staticDir: string;
  /** Serves `/api/overview`, `/api/metrics` and `/api/settings`; without it those paths are not found. */
  dashboard?: DashboardApi;
}

export interface HealthResponse {
  status: 'ok';
  service: 'bug-smasher';
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function findFile(path: string): Promise<{ path: string; size: number } | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size } : undefined;
  } catch {
    return undefined;
  }
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  staticRoot: string,
): Promise<void> {
  const requested = resolve(join(staticRoot, normalize(pathname)));
  if (requested !== staticRoot && !requested.startsWith(staticRoot + sep)) {
    sendText(res, 404, 'Not found');
    return;
  }

  let file = await findFile(requested);
  if (!file && extname(pathname) === '') {
    file = await findFile(join(staticRoot, 'index.html'));
    if (!file) {
      sendText(res, 503, 'Frontend assets are not built. Run `npm run build` first.');
      return;
    }
  }
  if (!file) {
    sendText(res, 404, 'Not found');
    return;
  }

  const handle = await open(file.path, 'r');
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
    'content-length': file.size,
  });
  if (req.method === 'HEAD') {
    await handle.close();
    res.end();
    return;
  }
  await pipeline(handle.createReadStream(), res);
}

/** A `Host` header naming a loopback host, with an optional port. Anything else may be DNS rebinding. */
export function isLocalHostHeader(header: string | undefined): boolean {
  if (header === undefined) return false;
  const match = /^(\[::1\]|[^:[\]]+)(?::\d{1,5})?$/.exec(header.trim());
  if (match === null) return false;
  const host = match[1] as string;
  return isLoopbackHost(host === '[::1]' ? '::1' : host);
}

export function createApp(options: AppOptions): Server {
  const staticRoot = resolve(options.staticDir);
  const dashboard = options.dashboard;
  const routes: Record<string, () => unknown> = {
    '/api/health': (): HealthResponse => ({ status: 'ok', service: 'bug-smasher' }),
    ...(dashboard === undefined
      ? {}
      : {
          '/api/overview': () => dashboard.overview(),
          '/api/metrics': () => dashboard.metrics(),
          '/api/settings': () => dashboard.settings(),
        }),
  };

  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    const api = pathname === '/api' || pathname.startsWith('/api/');

    if (!isLocalHostHeader(req.headers.host)) {
      if (api) sendJson(res, 403, { error: 'forbidden_host' });
      else sendText(res, 403, 'Forbidden host');
      return;
    }

    if (api) {
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
      if (route === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, route());
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    serveStatic(req, res, pathname, staticRoot).catch((error: unknown) => {
      console.error('Failed to serve static asset', error);
      if (!res.headersSent) {
        sendText(res, 500, 'Internal server error');
      } else {
        res.destroy();
      }
    });
  });
}
