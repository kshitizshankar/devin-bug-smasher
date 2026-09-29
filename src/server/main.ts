import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || DEFAULT_HOST;
const staticDir = process.env.STATIC_DIR || fileURLToPath(new URL('../../dist/web', import.meta.url));

const server = createApp({ staticDir });

server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`Bug Smasher scaffold listening on http://${displayHost}:${address.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
