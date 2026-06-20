import { Injectable } from '@nestjs/common';
import * as net from 'node:net';
import {
  CacheConnectParams,
  CacheConnection,
  CacheEngine,
  CacheEngineAdapter,
  CacheEntry,
  CacheServerInfo,
  CacheSetInput,
} from './cache-engine';

const CRLF = '\r\n';
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

// Line responses that terminate a non-get command.
const TERMINAL =
  /(\r\n|^)(STORED|NOT_STORED|EXISTS|NOT_FOUND|DELETED|TOUCHED|OK|END|ERROR)\r\n$/;
const ERROR_LINE = /^(ERROR|CLIENT_ERROR .*|SERVER_ERROR .*)$/;

// Treat a value as binary (→ base64) when UTF-8 decoding yields the replacement
// char or C0 control bytes other than tab/newline/CR. Mirrors the NATS adapter.
function isBinaryText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if (c === 0xfffd) return true;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

function decodeValue(data: Buffer): {
  value: string;
  encoding: 'utf8' | 'base64';
} {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (isBinaryText(text)) {
    return { value: data.toString('base64'), encoding: 'base64' };
  }
  return { value: text, encoding: 'utf8' };
}

/**
 * One Memcached session over the ASCII protocol. Commands are serialized (one
 * in-flight at a time) — the console issues a single op per port-forward then
 * closes. `get` is parsed byte-accurately (the VALUE header carries the byte
 * count) so values containing CRLF/"END" can't truncate the response.
 */
class MemcachedConnection implements CacheConnection {
  constructor(private readonly socket: net.Socket) {}

  async serverInfo(): Promise<CacheServerInfo> {
    const raw = (await this.exec('stats' + CRLF, endsWithEnd)).toString('utf8');
    const stat = new Map<string, string>();
    for (const line of raw.split(CRLF)) {
      const m = /^STAT (\S+) (.*)$/.exec(line);
      if (m) stat.set(m[1], m[2]);
    }
    const num = (k: string): number => Number(stat.get(k) ?? 0) || 0;
    return {
      version: stat.get('version') ?? 'unknown',
      uptimeSeconds: num('uptime'),
      currItems: num('curr_items'),
      totalItems: num('total_items'),
      bytes: num('bytes'),
      limitMaxBytes: num('limit_maxbytes'),
      getHits: num('get_hits'),
      getMisses: num('get_misses'),
      evictions: num('evictions'),
      currConnections: num('curr_connections'),
      totalConnections: num('total_connections'),
      cmdGet: num('cmd_get'),
      cmdSet: num('cmd_set'),
      bytesRead: num('bytes_read'),
      bytesWritten: num('bytes_written'),
    };
  }

  async get(key: string): Promise<CacheEntry | null> {
    const buf = await this.exec(`get ${key}${CRLF}`, getComplete);
    return parseGet(buf);
  }

  async set(input: CacheSetInput): Promise<void> {
    const payload = Buffer.from(input.value, 'utf8');
    const header = `set ${input.key} ${input.flags ?? 0} ${input.ttlSeconds ?? 0} ${payload.length}${CRLF}`;
    const buf = Buffer.concat([
      Buffer.from(header, 'utf8'),
      payload,
      Buffer.from(CRLF),
    ]);
    const res = (await this.exec(buf, lineDone)).toString('utf8');
    if (!res.startsWith('STORED')) {
      throw clientError(`Memcached did not store the value: ${res.trim()}`);
    }
  }

  async delete(key: string): Promise<boolean> {
    const res = (await this.exec(`delete ${key}${CRLF}`, lineDone)).toString(
      'utf8',
    );
    if (res.startsWith('DELETED')) return true;
    if (res.startsWith('NOT_FOUND')) return false;
    throw clientError(`Delete failed: ${res.trim()}`);
  }

  async flushAll(): Promise<void> {
    const res = (await this.exec(`flush_all${CRLF}`, lineDone)).toString(
      'utf8',
    );
    if (!res.startsWith('OK')) throw clientError(`Flush failed: ${res.trim()}`);
  }

  close(): Promise<void> {
    this.socket.end();
    return Promise.resolve();
  }

  // Write a command and accumulate the reply until `complete(buf)` is true.
  private exec(
    payload: string | Buffer,
    complete: (buf: Buffer) => boolean,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let acc = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        reject(clientError('Memcached request timed out'));
      }, REQUEST_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        acc = Buffer.concat([acc, chunk]);
        const line = firstLine(acc);
        if (line && ERROR_LINE.test(line)) {
          cleanup();
          reject(clientError(line));
          return;
        }
        if (complete(acc)) {
          cleanup();
          resolve(acc);
        }
      };
      const onErr = (e: Error): void => {
        cleanup();
        reject(e);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onErr);
      };
      this.socket.on('data', onData);
      this.socket.on('error', onErr);
      this.socket.write(payload);
    });
  }
}

function firstLine(buf: Buffer): string | null {
  const nl = buf.indexOf(CRLF);
  return nl === -1 ? null : buf.toString('latin1', 0, nl);
}

function endsWithEnd(buf: Buffer): boolean {
  return (
    buf.length >= 5 && buf.toString('latin1', buf.length - 5) === 'END\r\n'
  );
}

function lineDone(buf: Buffer): boolean {
  return TERMINAL.test(buf.toString('latin1'));
}

// Byte-accurate completeness for get: walk VALUE headers skipping their exact
// byte payloads so embedded CRLF/"END" in a value can't end the read early.
function getComplete(buf: Buffer): boolean {
  let i = 0;
  for (;;) {
    const nl = buf.indexOf(CRLF, i);
    if (nl === -1) return false;
    const line = buf.toString('latin1', i, nl);
    if (line === 'END' || ERROR_LINE.test(line)) return true;
    if (line.startsWith('VALUE ')) {
      const bytes = Number(line.split(' ')[3]) || 0;
      const valEnd = nl + 2 + bytes;
      if (buf.length < valEnd + 2) return false; // value + trailing CRLF
      i = valEnd + 2;
    } else {
      return true; // unexpected line — let the parser surface it
    }
  }
}

function parseGet(buf: Buffer): CacheEntry | null {
  let i = 0;
  for (;;) {
    const nl = buf.indexOf(CRLF, i);
    if (nl === -1) return null;
    const line = buf.toString('latin1', i, nl);
    if (line === 'END') return null;
    if (line.startsWith('VALUE ')) {
      const parts = line.split(' '); // VALUE <key> <flags> <bytes> [cas]
      const key = parts[1];
      const flags = Number(parts[2]) || 0;
      const bytes = Number(parts[3]) || 0;
      const valStart = nl + 2;
      const data = buf.subarray(valStart, valStart + bytes);
      const dec = decodeValue(data);
      return {
        key,
        flags,
        sizeBytes: bytes,
        value: dec.value,
        encoding: dec.encoding,
      };
    }
    if (ERROR_LINE.test(line)) throw clientError(line);
    i = nl + 2;
  }
}

// Tag an error so the query layer can surface it as a clean 400.
function clientError(message: string): Error {
  return Object.assign(new Error(message), { clientMessage: message });
}

/**
 * Memcached adapter. Speaks the ASCII protocol directly over a short-lived TCP
 * socket on the port-forward (no client dependency). The cluster-internal port +
 * the port-forward are the boundary — Memcached itself is unauthenticated.
 */
@Injectable()
export class MemcachedAdapter implements CacheEngineAdapter {
  readonly engines: CacheEngine[] = ['memcached'];

  connect(params: CacheConnectParams): Promise<CacheConnection> {
    return new Promise<CacheConnection>((resolve, reject) => {
      const socket = net.createConnection({
        host: params.host,
        port: params.port,
      });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(new MemcachedConnection(socket));
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(clientError('Connection to Memcached timed out'));
      });
      socket.once('error', (e) => reject(e));
    });
  }
}
