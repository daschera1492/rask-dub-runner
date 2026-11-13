/**
 * Rask.ai API client.
 *
 * Auth is AWS Cognito (`us-east-2_39TxAbWNH`, public Amplify client). A fresh
 * account is made from a throw-away emailnator Gmail address, confirmed with
 * the code Rask mails out, then registered in the two Rask backends:
 *
 *   1. POST https://rst.rask.ai/api/accounts/v1/users  {"token": <idToken>}
 *      (the media-library service keeps its own user row keyed by the sub)
 *   2. POST https://app.rask.ai/api/user  {}           (creates user + space)
 *
 * Dubbing only ever sends AUDIO. The returned MP4 contains a placeholder
 * picture and the dubbed track; the caller drops the picture and muxes the
 * audio back onto the original file, so nothing of the source video is ever
 * uploaded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requestJson, requestText, sleep, retry, HttpError, downloadFile } from './http.mjs';

export const COGNITO = {
  region: 'us-east-2',
  pool: 'us-east-2_39TxAbWNH',
  clientId: '3l205dqshftlhc51jbgppfe68n',
  endpoint: 'https://cognito-idp.us-east-2.amazonaws.com/',
};

const APP = 'https://app.rask.ai';
const RST = 'https://rst.rask.ai';

/** Target languages Rask understands, by `dst_lang` code. */
export const LANGUAGES = {
  'fa-ir': ['persian', 'farsi', 'persian ir', 'fa', 'fa-ir', 'iran'],
  'en-us': ['english', 'english us', 'en', 'en-us'],
  'en-gb': ['english uk', 'en-gb'],
  'ar-sa': ['arabic', 'ar', 'ar-sa'],
  'tr-tr': ['turkish', 'tr', 'tr-tr'],
  'de-de': ['german', 'de', 'de-de'],
  'fr-fr': ['french', 'fr', 'fr-fr'],
  'es-es': ['spanish', 'es', 'es-es'],
  'it-it': ['italian', 'it', 'it-it'],
  'ru-ru': ['russian', 'ru', 'ru-ru'],
  'hi-in': ['hindi', 'hi', 'hi-in'],
  'ur-pk': ['urdu', 'ur', 'ur-pk'],
  'zh-cn': ['chinese', 'chinese mandarin', 'zh', 'zh-cn'],
  'ja-jp': ['japanese', 'ja', 'ja-jp'],
  'ko-kr': ['korean', 'ko', 'ko-kr'],
  'pt-br': ['portuguese', 'pt', 'pt-br'],
  'nl-nl': ['dutch', 'nl', 'nl-nl'],
  'pl-pl': ['polish', 'pl', 'pl-pl'],
  'uk-ua': ['ukrainian', 'uk', 'uk-ua'],
  'az-az': ['azerbaijani', 'az', 'az-az'],
};

/** Resolve "Persian", "fa", "fa-ir" … to a Rask `dst_lang` code. */
export function resolveLanguage(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!raw) throw new Error('TARGET_LANG is empty');
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(raw) && LANGUAGES[raw]) return raw;
  for (const [code, aliases] of Object.entries(LANGUAGES)) {
    if (aliases.includes(raw.replace(/-/g, ' ')) || aliases.includes(raw)) return code;
  }
  if (/^[a-z]{2}-[a-z]{2}$/.test(raw)) return raw; // trust an explicit code
  throw new Error(`unknown target language "${input}" — pass a Rask code like fa-ir`);
}

export function randomPassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  let core = '';
  for (let i = 0; i < 12; i++) core += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `Rask${core}9!`;
}

/* ------------------------------------------------------------------ */
/* Cognito                                                             */
/* ------------------------------------------------------------------ */

async function cognito(target, body) {
  // Goes through the same proxy context as the Rask calls, so one account is
  // always signed up and used from one exit IP.
  const { status, text } = await requestText(COGNITO.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
    timeoutMs: 60_000,
    label: `cognito ${target}`,
  });
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw below */ }
  if (!(status >= 200 && status < 300)) {
    const code = json?.__type || '';
    const err = new HttpError(`cognito ${target}: ${status} ${String(text).slice(0, 200)}`, { status, body: text });
    err.cognitoType = code.replace(/^.*#/, '');
    throw err;
  }
  return json || {};
}

export async function signUp(email, password, { resend = false } = {}) {
  if (resend) {
    return cognito('ResendConfirmationCode', { ClientId: COGNITO.clientId, Username: email });
  }
  return cognito('SignUp', {
    ClientId: COGNITO.clientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  });
}

export async function confirmSignUp(email, code) {
  return cognito('ConfirmSignUp', {
    ClientId: COGNITO.clientId,
    Username: email,
    ConfirmationCode: String(code).trim(),
  });
}

export async function login(email, password) {
  const json = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: COGNITO.clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (!json.AuthenticationResult) throw new Error(`login challenge: ${json.ChallengeName || 'unknown'}`);
  return {
    idToken: json.AuthenticationResult.IdToken,
    accessToken: json.AuthenticationResult.AccessToken,
    refreshToken: json.AuthenticationResult.RefreshToken,
  };
}

/* ------------------------------------------------------------------ */
/* Rask backends                                                       */
/* ------------------------------------------------------------------ */

const authHeaders = (tokens) => ({ authorization: `Bearer ${tokens.idToken}` });

function api(url, { method = 'GET', tokens, body, headers = {}, ...rest } = {}) {
  const isRaw = body === undefined || typeof body === 'string' || body instanceof FormData || body instanceof Blob;
  return requestJson(url, {
    method,
    headers: { ...authHeaders(tokens), ...headers },
    body: isRaw ? body : JSON.stringify(body),
    label: `${method} ${url.replace(/^https:\/\/[^/]+/, '')}`,
    ...rest,
  });
}

/** Register the Cognito user in both Rask services (idempotent). */
export async function bootstrap(tokens) {
  await requestJson(`${RST}/api/accounts/v1/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tokens.idToken }),
    allowFail: false,
  }).catch((err) => {
    // 400 "already exists" is the normal case when reusing an account.
    if (Number(err?.status) === 400 && /already exists/i.test(String(err?.body || ''))) return null;
    throw err;
  });

  await api(`${APP}/api/user`, {
    method: 'POST',
    tokens,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export function getUser(tokens) {
  return api(`${APP}/api/user`, { tokens });
}

export async function getSpace(tokens) {
  const spaces = await api(`${APP}/api/space`, { tokens });
  const space = Array.isArray(spaces) ? spaces[0] : null;
  if (!space) throw new Error('account has no space');
  return space;
}

export function getCredits(tokens) {
  return api(`${APP}/api/user`, { tokens }).then((u) => u.credits || {});
}

/** Minutes that can still be dubbed, and videos that can still be made. */
export function remaining(credits) {
  const left = (c) => Math.max(0, Number(c?.total || 0) - Number(c?.used || 0));
  return { minutes: left(credits?.minutes), videos: left(credits?.video) };
}

const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
};

/** Upload one audio chunk to Rask's media library; returns the media object. */
export async function uploadAudio(tokens, spaceId, filePath, name = path.basename(filePath)) {
  const buf = fs.readFileSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const form = new FormData();
  form.append('data', new Blob([buf], { type }), name);
  return api(`${RST}/api/library/v1/media?space_id=${spaceId}`, {
    method: 'POST',
    tokens,
    body: form,
    timeoutMs: 5 * 60_000,
    // Media never rides the metered residential proxy: the upload leaves from
    // the runner's own connection, exactly like the downloads do.
    direct: true,
  });
}

/** Create a dubbing project from an uploaded media id (audio-only uploads OK). */
export function createProject(tokens, spaceId, { mediaId, name, dstLang }) {
  return api(`${APP}/api/project/?space_id=${spaceId}`, {
    method: 'POST',
    tokens,
    headers: { 'content-type': 'application/json' },
    body: {
      name,
      dst_lang: dstLang,
      free_dubbing: false,
      src_lang: null,
      prompt: null,
      space_id: spaceId,
      video_id: mediaId,
    },
  });
}

export function getProject(tokens, spaceId, projectId) {
  return api(`${APP}/api/project/${projectId}?space_id=${spaceId}`, { tokens });
}

/**
 * Poll a project until the localized file exists.
 *
 * Rask occasionally parks a project in one status forever (seen with very
 * short, speech-less or unlucky uploads: `transcription_started` never
 * advances), and every project on that same account parks with it. A fresh
 * account is the only way out, so the watchdog fails fast: a healthy project
 * finishes in 70-270 s, and 4 idle minutes mean the account is dead weight.
 *
 * Errors carry `stalled = true` and `accountSuspect = true` so the caller can
 * retire the account instead of burning another minute on it.
 *
 * @returns {Promise<object>} the finished project record
 */
export async function waitForProject(tokens, spaceId, projectId, {
  timeoutMs = 20 * 60_000,
  pollMs = 5000,
  stallMs = 4 * 60_000,
  onTick = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    const project = await getProject(tokens, spaceId, projectId);
    if (project.status !== last) {
      last = project.status;
      changedAt = Date.now();
      onTick(project);
    }
    if (project.error_message) {
      const err = new Error(`rask project failed: ${project.error_message}`);
      err.projectId = projectId;
      err.status = project.status;
      throw err;
    }
    if (project.translated_video || project.translated_audio) return project;
    if (Date.now() - changedAt > stallMs) {
      const err = new Error(
        `rask project ${projectId} stalled at "${last}" for ${Math.round(stallMs / 60000)}m`,
      );
      err.stalled = true;
      err.accountSuspect = true;
      err.projectId = projectId;
      err.status = last;
      throw err;
    }
    await sleep(pollMs);
  }
  const err = new Error(`rask project ${projectId} timed out at "${last}"`);
  err.stalled = true;
  err.accountSuspect = true;
  err.projectId = projectId;
  err.status = last;
  throw err;
}

export async function startAccount({ emailnator, otpWaitSeconds = 180 }) {
  const password = randomPassword();
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    // emailnator throttles bursts (429/503), so the address request itself gets
    // a patient retry before we give up on this attempt.
    const { email } = await retry(() => emailnator.generateAddress(), {
      attempts: 5, delayMs: 12_000, label: 'emailnator generate-email',
    });
    try {
      await signUp(email, password);
      console.log(`${new Date().toISOString()} [account] ${email} signed up`);
      // The wrapper in run.mjs already defaults waitSeconds from
      // OTP_WAIT_SECONDS; passing it explicitly used to overwrite that value.
      const { code } = await emailnator.waitForCode(email, { waitSeconds: otpWaitSeconds });
      await confirmSignUp(email, code);
      console.log(`${new Date().toISOString()} [account] ${email} confirmed`);
      const tokens = await login(email, password);
      await bootstrap(tokens);
      const space = await getSpace(tokens);
      const credits = await getCredits(tokens);
      console.log(`${new Date().toISOString()} [account] ${email} ready (space ${space.id}, credits ${JSON.stringify(remaining(credits))})`);
      return { email, password, tokens, spaceId: space.id, credits };
    } catch (err) {
      lastError = err;
      if (err?.cognitoType === 'UsernameExistsException') continue;
      if (attempt === 3) break;
      console.warn(`${new Date().toISOString()} [account] attempt ${attempt} failed: ${String(err.message).slice(0, 200)}`);
      await sleep(3000 * attempt);
    }
  }
  throw lastError;
}

/**
 * Dub one audio chunk on an account and save the dubbed audio locally.
 * @returns {Promise<{file:string, projectId:string, duration:number}>}
 */
export async function dubAudio({ tokens, spaceId, audioFile, name, dstLang, workDir, onStatus = () => {}, beforeCreate = () => {} }) {
  const media = await retry(() => uploadAudio(tokens, spaceId, audioFile, `${name}${path.extname(audioFile)}`), {
    attempts: 3, label: 'upload', delayMs: 4000,
  });
  if (!media?.id) throw new Error('upload returned no media id');

  // The upload itself is free; creating the project is what costs a minute.
  await beforeCreate();

  const project = await createProject(tokens, spaceId, { mediaId: media.id, name, dstLang });
  const projectId = project.id;
  console.log(`[rask] ${name}: project ${projectId}`);

  const done = await waitForProject(tokens, spaceId, projectId, {
    onTick: (p) => {
      console.log(`[rask] ${name}: ${p.status}`);
      onStatus(p);
    },
  });

  const rel = done.translated_video || done.translated_audio;
  const url = rel.startsWith('http') ? rel : APP + rel;
  fs.mkdirSync(workDir, { recursive: true });
  const mp4 = path.join(workDir, `${name}-rask.mp4`);
  await retry(() => downloadFile(url, mp4), { attempts: 3, label: 'download', delayMs: 3000 });

  return { file: mp4, projectId, duration: Number(done.duration || 0) };
}
