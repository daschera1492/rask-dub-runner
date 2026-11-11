/**
 * HTTP helpers: JSON requests, file downloads, sleeps and retries.
 *
 * Requests are tunnelled through an HTTP CONNECT proxy only when one is set in
 * the current async context (`withProxy`). Each Rask account runs inside its own
 * context, so concurrent workers keep separate sticky exit IPs without passing a
 * proxy argument through every function.
 *
 * Downloads (presigned S3) and the input video always stay on the runner's own
 * connection: they carry the bulk of the bytes and never identify the account.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', url, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

/* ------------------------------------------------------------------ */
/* Proxy context                                                       */
/* ------------------------------------------------------------------ */

const proxyContext = new AsyncLocalStorage();

/** Run `fn` with every subsequent API call going through `proxy`. */
export function withProxy(proxy, fn) {
  if (!proxy) return fn();
  return proxyContext.run(proxy, fn);
}

export function activeProxy() {
  return proxyContext.getStore() || null;
}

/** Dial the proxy, ask it for a CONNECT tunnel and hand back the raw socket. */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error(`proxy ${proxy.host}:${proxy.port} timed out`)));
    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64');
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n`
          + `Host: ${host}:${port}\r\n`
          + `Proxy-Authorization: Basic ${auth}\r\n`
          + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 32 * 1024) fail(new Error('proxy sent an oversized CONNECT reply'));
        return;
      }
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 200) {
        fail(new Error(`proxy CONNECT ${host}:${port} failed: ${statusLine}`));
        return;
      }
      settled = true;
      const extra = Buffer.from(head.slice(end + 4), 'latin1');
      if (extra.length) socket.unshift(extra);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/**
 * Agent that replaces the TCP connect with a proxy tunnel. TLS still happens
 * here, because Node would otherwise dial the target directly.
 */
function tunnelAgentClass(Base) {
  return class TunnelAgent extends Base {
    constructor(proxy, { isTls, host, timeoutMs }) {
      super({ keepAlive: false });
      this.proxy = proxy;
      this.isTls = isTls;
      this.targetHost = host;
      this.timeoutMs = timeoutMs;
    }

    createConnection(options, callback) {
      let settled = false;
      const done = (err, socket) => {
        if (settled) {
          if (socket) socket.destroy();
          return;
        }
        settled = true;
        callback(err, socket);
      };

      const port = options.port || (this.isTls ? 443 : 80);
      openTunnel(this.proxy, this.targetHost, port, this.timeoutMs)
        .then((raw) => {
          if (!this.isTls) {
            done(null, raw);
            return;
          }
          const secure = tls.connect({ socket: raw, servername: this.targetHost, ALPNProtocols: ['http/1.1'] });
          // A stuck handshake must never wedge the whole run.
          secure.setTimeout(this.timeoutMs, () => {
            secure.destroy();
            done(new Error(`proxy TLS handshake to ${this.targetHost} timed out`));
          });
          secure.once('secureConnect', () => {
            secure.setTimeout(0);
            done(null, secure);
          });
          secure.once('error', (err) => done(err));
        })
        .catch((err) => done(err));
    }
  };
}

const TunnelHttpAgent = tunnelAgentClass(http.Agent);
const TunnelHttpsAgent = tunnelAgentClass(https.Agent);

/** Same contract as fetch(), but the TCP connection goes through the proxy. */
function proxiedRequest(url, { method, headers, body, timeoutMs, proxy }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isTls = target.protocol === 'https:';
    const mod = isTls ? https : http;
    const agent = new (isTls ? TunnelHttpsAgent : TunnelHttpAgent)(proxy, { isTls, host: target.hostname, timeoutMs });

    // Hard ceiling: whatever the socket is doing (dial, CONNECT, handshake,
    // stalled body) the call settles, so a bad exit IP can never hang a run.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new HttpError(`${method} ${url} failed: proxy timeout after ${timeoutMs}ms`, { url }));
    }, timeoutMs + 5000);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    // Always announce the payload length: without it Node switches to
    // `transfer-encoding: chunked`, which some gateways reject.
    const finalHeaders = { ...headers };
    if (body !== undefined) {
      finalHeaders['content-length'] = String(Buffer.byteLength(body));
      delete finalHeaders['transfer-encoding'];
    }

    const req = mod.request(
      {
        method,
        headers: finalHeaders,
        agent,
        host: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        servername: isTls ? target.hostname : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', (err) => finish(reject, err));
        res.on('end', () => finish(resolve, {
          status: res.statusCode || 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );

    req.on('error', (err) => finish(reject, new HttpError(`${method} ${url} failed: ${err.message}`, { url })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Turn a FormData into a flat Buffer + boundary. Node's fetch can post a
 * FormData directly, but the raw client used for proxied requests cannot, so
 * both paths get the same pre-encoded body.
 */
async function encodeMultipart(form) {
  const boundary = `----rask${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
      continue;
    }
    const buf = Buffer.from(await value.arrayBuffer());
    const filename = String(value.name || name).replace(/["\r\n]/g, '_');
    const type = value.type || 'application/octet-stream';
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
        + `Content-Type: ${type}\r\n\r\n`,
    ));
    parts.push(buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function retryAfterMs(headers) {
  const raw = headers?.['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * One HTTP exchange, returning the raw text. Honours the ambient proxy unless
 * `direct` is set. Bodies: undefined | string | Buffer | FormData | Blob.
 */
export async function requestText(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 60_000,
  direct = false,
  label = '',
} = {}) {
  let payload = body;
  const finalHeaders = { ...headers };

  if (payload instanceof FormData) {
    const encoded = await encodeMultipart(payload);
    payload = encoded.body;
    finalHeaders['content-type'] = encoded.contentType;
  } else if (payload instanceof Blob) {
    if (payload.type && !finalHeaders['content-type']) finalHeaders['content-type'] = payload.type;
    payload = Buffer.from(await payload.arrayBuffer());
  } else if (payload instanceof URLSearchParams) {
    payload = payload.toString();
    if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
  } else if (
    payload !== undefined
    && payload !== null
    && typeof payload === 'object'
    && !Buffer.isBuffer(payload)
    && !(payload instanceof ArrayBuffer)
    && !ArrayBuffer.isView(payload)
  ) {
    // Plain objects are JSON; the raw proxy client only writes strings/Buffers.
    payload = JSON.stringify(payload);
    if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
  }

  const proxy = direct ? null : activeProxy();

  if (proxy) {
    // fetch() always sends a user-agent; the raw client must match it so the
    // site sees the same client, just from another IP.
    const proxiedHeaders = { 'user-agent': 'undici', ...finalHeaders };
    const { status, headers: responseHeaders, text } = await proxiedRequest(url, {
      method, headers: proxiedHeaders, body: payload, timeoutMs, proxy,
    });
    return { status, headers: responseHeaders, text, label };
  }

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal });
  } catch (err) {
    throw new HttpError(`${label || url}: ${err.message}`, { status: 0, url });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  return { status: res.status, headers: res.headers, text, label };
}

/**
 * Fetch a URL and parse JSON.
 * @returns {Promise<any>}
 */
export async function requestJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 60_000,
  label = '',
  direct = false,
} = {}) {
  const name = label || `${method} ${url}`;
  const { status, headers: responseHeaders, text } = await requestText(url, {
    method, headers, body, timeoutMs, direct, label: name,
  });

  if (!(status >= 200 && status < 300)) {
    throw new HttpError(`${name}: HTTP ${status} ${String(text).slice(0, 300)}`, {
      status,
      body: text,
      url,
      retryAfterMs: retryAfterMs(responseHeaders),
    });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${name}: invalid JSON ${String(text).slice(0, 200)}`, { status, body: text, url });
  }
}

export function isTransient(err) {
  const status = Number(err?.status);
  return !status || status === 408 || status === 429 || status >= 500;
}

export async function retry(fn, { attempts = 3, delayMs = 2000, label = 'task' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransient(err)) break;
      console.warn(`[retry] ${label} attempt ${attempt} failed: ${String(err.message).slice(0, 160)}`);
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Download a URL to disk, following redirects, with a hard timeout.
 * Always direct: these are presigned media URLs, not account-bound calls.
 */
export async function downloadFile(url, destPath, { timeoutMs = 15 * 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new HttpError(`download ${res.status}`, { status: res.status, url });
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import('node:fs');
    fs.writeFileSync(destPath, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}
