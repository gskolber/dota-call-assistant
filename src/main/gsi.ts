// Minimal HTTP endpoint for Dota 2 Game State Integration.
// Valve's client POSTs a JSON snapshot here a few times per second while a
// match is running. Nothing is ever sent out; the socket is bound to loopback.

import { EventEmitter } from 'node:events';
import http from 'node:http';

import type { GsiPayload, GsiStatus } from '../shared/types';

export const PORT = 3000;
export const HOST = '127.0.0.1';

/** real payloads sit around 8 KB; anything near a megabyte is not Dota */
const MAX_BODY = 1024 * 1024;

/** a gap longer than this means the game (or the app) went away and came back */
const RECONNECT_GAP_MS = 15_000;

export interface GsiEvents {
  payload: [GsiPayload];
  status: [GsiStatus];
}

export class GsiServer extends EventEmitter<GsiEvents> {
  private server: http.Server | null = null;
  private token: string | null = null;
  private stats: Omit<GsiStatus, 'token'> = {
    listening: false,
    port: PORT,
    host: HOST,
    payloads: 0,
    rejected: 0,
    lastPayloadAt: null,
    avgMs: 0,
    reconnects: 0,
    error: null,
  };

  start(token: string): void {
    this.token = token;
    if (this.server) return;

    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.stats.listening = false;
      this.stats.error = err.code === 'EADDRINUSE'
        ? `A porta ${PORT} já está ocupada por outro programa.`
        : err.message;
      this.emit('status', this.status());
    });
    server.listen(PORT, HOST, () => {
      this.stats.listening = true;
      this.stats.error = null;
      this.emit('status', this.status());
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.stats.listening = false;
  }

  status(): GsiStatus {
    return { ...this.stats, token: this.token };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const started = process.hrtime.bigint();

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Call Assistant GSI endpoint. Dota 2 posts here.');
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => { /* client vanished mid-post; nothing to do */ });

    req.on('end', () => {
      // Dota retries on a slow endpoint, so answer before parsing
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('');

      let payload: GsiPayload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GsiPayload;
      } catch {
        this.stats.rejected += 1;
        return;
      }

      if (this.token && payload.auth?.token !== this.token) {
        this.stats.rejected += 1;
        this.emit('status', this.status());
        return;
      }

      const now = Date.now();
      if (this.stats.lastPayloadAt && now - this.stats.lastPayloadAt > RECONNECT_GAP_MS) {
        this.stats.reconnects += 1;
      }
      this.stats.payloads += 1;
      this.stats.lastPayloadAt = now;

      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.stats.avgMs = this.stats.avgMs ? this.stats.avgMs * 0.9 + ms * 0.1 : ms;

      this.emit('payload', payload);
    });
  }
}
