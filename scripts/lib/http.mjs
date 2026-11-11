/**
 * Small HTTP helpers: JSON requests, file downloads, sleeps and retries.
 * No proxy support on purpose — Rask accounts are used from one stable IP.
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
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
} = {}) {
  // Plain objects are JSON; FormData/Blob/string bodies pass through untouched.
  const isRaw = body === undefined
    || typeof body === 'string'
    || body instanceof FormData
    || body instanceof Blob
    || body instanceof URLSearchParams
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body);
  const payload = isRaw ? body : JSON.stringify(body);
  const finalHeaders = isRaw ? { ...headers } : { 'content-type': 'application/json', ...headers };

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal });
  } catch (err) {
    throw new HttpError(`${label || url}: ${err.message}`, { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(`${label || url}: HTTP ${res.status} ${text.slice(0, 300)}`, { status: res.status, body: text });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${label || url}: invalid JSON ${text.slice(0, 200)}`, { status: res.status, body: text });
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

/** Download a URL to disk, following redirects, with a hard timeout. */
export async function downloadFile(url, destPath, { timeoutMs = 15 * 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new HttpError(`download ${res.status}`, { status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import('node:fs');
    fs.writeFileSync(destPath, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}
