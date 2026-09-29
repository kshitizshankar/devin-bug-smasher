import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface AppOptions {
  staticDir: string;
}

export interface HealthResponse {
  status: 'ok';
  service: 'bug-smasher';
  stage: 'scaffold';
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

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
    'content-length': file.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
}

export function createApp(options: AppOptions): Server {
  const staticRoot = resolve(options.staticDir);

  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (pathname === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const body: HealthResponse = { status: 'ok', service: 'bug-smasher', stage: 'scaffold' };
      sendJson(res, 200, body);
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' });
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
