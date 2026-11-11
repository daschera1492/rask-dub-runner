/**
 * Identity provider backed by emailnator.com (real @gmail.com temp inbox).
 *
 * Drop-in replacement for bridge.mjs: run.mjs only needs
 *
 *   IDENTITY_PROVIDER=emailnator
 *
 * and the accounts stop coming from the WordPress bridge. Every worker gets a
 * fresh random Gmail address and the login code is read straight from the
 * public inbox through emailnator's own JSON API (the same one the site uses).
 *
 * Which alias shape is issued is controlled by EMAILNATOR_IDS, matching the
 * toggles on the site (the request body is `{"ids":[...]}`):
 *
 *   1 = Domain       (plain …@gmail.com)
 *   2 = +Gmail       (name+tag@gmail.com)
 *   3 = .Gmail       (name.with.dots@gmail.com)   <-- default, only this one
 *   8 = GoogleMail   (googlemail.com)
 *
 * Default is `3` because that is the single toggle this runner wants on.
 *
 * Caveat: the free inbox is public. Anyone who knows the address can read it,
 * so these accounts are for OTP signups only — never for private mail.
 */

import { requestJson, sleep } from './http.mjs';

const BASE = (process.env.EMAILNATOR_BASE_URL || 'https://www.emailnator.com').replace(/\/$/, '');

const clampi = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

const EMAIL_TYPE_DOT_GMAIL = 3;
const IDS = (process.env.EMAILNATOR_IDS || String(EMAIL_TYPE_DOT_GMAIL))
  .split(/[,\s]+/)
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n) && n > 0);

const POLL_MS = clampi((Number(process.env.EMAILNATOR_POLL_SECONDS) || 4) * 1000, 2000, 15000);
// Gmail ignores dots, so every dot alias of one base name shares one inbox.
// emailnator issues random base names, but an old message from another alias
// (or the day-old "upgrade" placeholders) must never be mistaken for our code:
// only unlocked mail newer than this window is considered.
const MAX_AGE_MS = clampi(Number(process.env.EMAILNATOR_MAX_AGE_SECONDS || 180) * 1000, 30_000, 3_600_000);
const BODY_FETCH = !['0', 'false', 'no'].includes(String(process.env.EMAILNATOR_FETCH_BODY || '').toLowerCase());
const REQUEST_TIMEOUT_MS = clampi(Number(process.env.EMAILNATOR_TIMEOUT_SECONDS || 25) * 1000, 5000, 60000);
// Optional sender filter, e.g. "vosko" or "no-reply@vosko.ai". Empty = accept
// any sender, which is fine because every identity is a brand-new address.
const FROM_FILTER = (process.env.EMAILNATOR_FROM_MATCH || '').trim();
const FROM_RE = FROM_FILTER ? new RegExp(FROM_FILTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

function api(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return requestJson(BASE + path, {
    method,
    body,
    timeoutMs,
    // Our helper (emailnator) is not the target site: never spend residential
    // proxy bandwidth on it, and keep one stable IP for the inbox polls.
    direct: true,
    headers: {
      accept: 'application/json',
      referer: `${BASE}/`,
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
}

function isTransient(err) {
  const status = Number(err?.status);
  return !status || status === 429 || status >= 500;
}

/** A new random address from emailnator (the site's "Generate New" button). */
export async function generateAddress() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const data = await api('/api/generate-email', { method: 'POST', body: { ids: IDS } });
      const email = String(data?.email || '').trim();
      if (email && email.includes('@')) return { email, type: data.type || 'PUBLIC', typeId: Number(data.email_type_id || 0) };
      lastError = new Error(`generate-email returned no address: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt === 5 || !isTransient(lastError)) break;
    await sleep(1500 * attempt);
  }
  throw lastError;
}

export function configured() {
  return true;
}

/* ------------------------------------------------------------------ */
/* Run tracking: the bridge used to provide this. Locally it is just a */
/* log line plus a stable id so run.mjs keeps working unchanged.       */
/* ------------------------------------------------------------------ */

let runCounter = 0;

export async function createRun({ videoUrl, sourceLang, targetLang, chunkTotal, meta }) {
  runCounter += 1;
  const id = Number(`${Date.now()}`.slice(-9)) * 10 + runCounter;
  console.log(`[run] local ${id}: ${sourceLang} -> ${targetLang}, ${chunkTotal} chunk(s), ${meta?.outputMode || 'audio'}`);
  console.log(`[run] input ${videoUrl}`);
  return { id, run_key: `local-${id.toString(36)}`, status: 'queued' };
}

// Async on purpose: run.mjs calls `.catch()` on the result, exactly like the
// bridge client returned promises from HTTP.
export async function updateRun(id, fields) {
  const interesting = ['status', 'chunk_done', 'output_name', 'error'].filter((k) => fields?.[k] !== undefined);
  if (interesting.length) {
    console.log(`[run] ${id}: ${interesting.map((k) => `${k}=${String(fields[k]).slice(0, 160)}`).join(', ')}`);
  }
  return { id, ...fields };
}

export async function mintIdentity(runId, chunkIndex) {
  const { email, type, typeId } = await generateAddress();
  return {
    id: email, // the address is the identity here
    email,
    run_id: runId,
    chunk_index: chunkIndex,
    status: 'minted',
    type,
    email_type_id: typeId,
  };
}

export async function updateIdentity(id, fields) {
  if (fields?.status) console.log(`[identity] ${id}: ${fields.status}`);
  return { id, ...fields };
}

/* ------------------------------------------------------------------ */
/* Inbox reading + OTP extraction                                      */
/* ------------------------------------------------------------------ */

/** Messages in one public inbox (newest first when the API gives timestamps). */
export async function listMessages(email, { limit = 20 } = {}) {
  const data = await api('/api/message-list', { method: 'POST', body: { email, limit } });
  const messages = Array.isArray(data?.messages) ? data.messages.slice() : [];
  messages.sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  return { messages, count: Number(data?.message_count || messages.length), raw: data };
}

/** Full body of one message, if emailnator exposes it. */
export async function getMessage(id) {
  try {
    return await api(`/api/message/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

function flattenStrings(value, out = [], depth = 0) {
  if (value == null || depth > 6) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flattenStrings(v, out, depth + 1));
  else if (typeof value === 'object') Object.values(value).forEach((v) => flattenStrings(v, out, depth + 1));
  return out;
}

function plainText(value) {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the login code out of a subject/body.
 * Labelled hits ("verification code: 123456") win over a bare 6-digit run,
 * because OTP mails always contain other numbers (year, order id, expiry).
 */
export function extractCode(text) {
  const t = plainText(text);
  if (!t) return '';

  const labelled = [
    /(?:verification|verify|login|log[-\s]?in|sign[-\s]?in|security|one[-\s]?time|confirmation|access|authentication)\s*(?:code|pin|otp|token)?[^0-9]{0,40}(\d{4,8})\b/i,
    /\b(?:code|otp|pin|passcode|token)\b[^0-9]{0,20}(\d{4,8})\b/i,
    /\b(\d{4,8})\b[^0-9]{0,20}\b(?:is your|as your)\b/i,
  ];
  for (const re of labelled) {
    const m = t.match(re);
    if (m) return m[1];
  }

  const six = t.match(/(?<!\d)(\d{6})(?!\d)/);
  if (six) return six[1];
  const any = t.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return any ? any[1] : '';
}

/**
 * Poll an inbox until a login code shows up.
 * @returns {Promise<{code:string,message_id:string,subject:string,sender:string,source:string}>}
 */
export async function waitForCode(email, { waitSeconds = 60 } = {}) {
  const deadline = Date.now() + Math.max(5, waitSeconds) * 1000;
  const cutoff = Date.now() - MAX_AGE_MS;
  const seen = new Set();
  let polls = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    polls += 1;
    let inbox = null;
    try {
      inbox = await listMessages(email);
    } catch (err) {
      lastError = err;
      console.log(`[inbox] poll ${polls} failed: ${err.message.slice(0, 160)}`);
    }

    for (const message of inbox?.messages || []) {
      const id = String(message?.id ?? message?.messageID ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Locked rows are the premium placeholder, never a real code.
      if (message?.locked === true) continue;

      const raw = Number(message?.timestamp || 0);
      const sentAt = raw > 1e12 ? raw : raw * 1000; // the API sends seconds
      if (sentAt && sentAt < cutoff) continue;

      const sender = plainText(message?.from || '');
      const subject = plainText(message?.subject || '');
      if (FROM_RE && !FROM_RE.test(sender) && !FROM_RE.test(subject)) continue;

      let code = extractCode(`${subject} ${sender}`);
      if (!code && BODY_FETCH) {
        const full = await getMessage(id);
        if (full) code = extractCode(flattenStrings(full).join(' '));
      }
      if (code) {
        return { code, message_id: id, subject, sender, source: 'emailnator' };
      }
    }

    await sleep(POLL_MS);
  }

  throw new Error(
    `no code for ${email} within ${waitSeconds}s`
      + ` (${seen.size} message(s) seen${lastError ? `, last error: ${lastError.message.slice(0, 120)}` : ''})`,
  );
}
