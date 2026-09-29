import type { AddressInfo } from 'node:net';
import { loadSettings, SettingsError, type Settings } from '../config/settings.ts';
import { createApp } from './app.ts';

let settings: Settings;
try {
  settings = loadSettings();
} catch (error) {
  if (error instanceof SettingsError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const { host, port, staticDir } = settings.server;

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
