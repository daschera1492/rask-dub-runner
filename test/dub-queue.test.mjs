/**
 * Offline test for the account pool (`scripts/lib/dub.mjs`).
 *
 * No Rask, no emailnator, no ffmpeg: the `deps` seam replaces every network and
 * media call, so the queue can be driven through the failure modes that run
 * 43106519120 actually hit:
 *
 *  - an account whose projects all park at `transcription_started` (retire it,
 *    do not keep spending minutes),
 *  - a chunk that fails for real (retry it twice at the end, each round on a
 *    brand-new account),
 *  - the last minute of an account running out while a chunk is starting
 *    (move it to the fresh account instead of failing it),
 *  - parallel workers racing each other at a rollover (never open an account
 *    and retire it again one millisecond later).
 *
 *   node test/dub-queue.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dubLib = await import(pathToFileURL(path.join(repo, 'scripts/lib/dub.mjs')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rask-dub-test-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(path.join(work, 'dub'), { recursive: true });

const chunks = Array.from({ length: 7 }, (_, i) => ({
  index: i,
  start: i * 50,
  end: (i + 1) * 50,
  duration: 50,
  file: `chunks/chunk-${String(i).padStart(3, '0')}.m4a`,
}));

const cfg = {
  target: 'fa-ir',
  parallel: 2,
  chunkTries: 3,
  retryRounds: 2,
  maxAccounts: 0,
  otpWait: 30,
  dubDir: path.join(work, 'dub'),
  raskDir: path.join(work, 'rask'),
};

/**
 * Fake Rask:
 *  - account #1 is poisoned: every project parks at `transcription_started`,
 *  - chunk 3 fails for real on every account,
 *  - everything else succeeds.
 */
function makeFakeRask() {
  const state = {
    opened: 0,
    minutes: new Map(), // email -> minutes spent
    stalledAccounts: [],
    chunkAccounts: new Map(),
  };

  const deps = {
    withProxy: (_exit, fn) => fn(),
    forIdentity: () => null,
    sleep: async () => {},

    startAccount: async ({ emailnator }) => {
      const { email } = await emailnator.generateAddress();
      state.opened += 1;
      state.minutes.set(email, 0);
      return {
        email,
        tokens: { t: email },
        spaceId: `space-${email}`,
        credits: { minutes: { total: 3, used: 0 }, video: { total: 5, used: 0 } },
      };
    },

    remaining: (c) => ({
      minutes: Math.max(0, c.minutes.total - c.minutes.used),
      videos: Math.max(0, c.video.total - c.video.used),
    }),

    getCredits: async (tokens) => ({
      minutes: { total: 3, used: state.minutes.get(tokens.t) || 0 },
      video: { total: 5, used: state.minutes.get(tokens.t) || 0 },
    }),

    generateAddress: async () => ({ email: `acc${state.opened}@gmail.com` }),
    waitForCode: async () => ({ code: '000000' }),

    dubAudio: async ({ tokens, name, beforeCreate }) => {
      const email = tokens.t;
      const poisoned = email === 'acc1@gmail.com';
      // The minute is charged when the project is created, not when it ends.
      await beforeCreate();
      const index = Number(name.replace('chunk-', ''));

      if (poisoned) {
        state.stalledAccounts.push(email);
        const err = new Error(`rask project p-${index} stalled at "transcription_started" for 4m`);
        err.stalled = true;
        err.accountSuspect = true;
        err.status = 'transcription_started';
        throw err;
      }

      state.minutes.set(email, (state.minutes.get(email) || 0) + 1);
      if (index === 3) throw new Error('rask project failed: unsupported audio, try again');

      state.chunkAccounts.set(index, email);
      const file = path.join(work, 'rask', `${name}.mp4`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fake');
      return { file, projectId: `p-${index}`, duration: 50 };
    },

    extractAudioFromMp4: async (_mp4, out) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'raw');
      return out;
    },

    // Mimics the real media helper when the dub already matches its span: it
    // returns the raw file without writing `out`. The queue still has to leave
    // a normalised <name>.mp3 behind, because that is all the artifact keeps.
    fitChunkAudio: async (raw) => raw,
  };

  return { deps, state };
}

const failures = [];
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${label}${detail ? ` (${detail})` : ''}`);
};

const state = { chunks: {} };
const stateFile = path.join(work, 'state.json');
const saves = [];
// Same contract as pipeline.mjs: the payload must carry the chunk state, or
// JSON.stringify returns undefined and fs throws a useless "data argument"
// error deep inside the queue.
const saveState = (payload) => {
  const json = JSON.stringify(payload);
  if (!json) throw new TypeError('saveState was called without the state payload');
  fs.writeFileSync(stateFile, json);
  saves.push(Object.keys(payload.chunks).length);
};
const { deps, state: fake } = makeFakeRask();

const result = await dubLib.dubQueue({
  chunks,
  cfg,
  workDir: work,
  state,
  saveState,
  deps,
});

console.log('\n--- stall + retry rounds ---');
check('one chunk still missing (the one that always fails)',
  result.failures.length === 1 && result.failures[0][0] === 3, JSON.stringify(result.failures));
check('a stalled project retires its account at once', fake.stalledAccounts.length >= 1,
  fake.stalledAccounts.join(','));
check('the poisoned account dubbed nothing',
  ![...fake.chunkAccounts.values()].includes('acc1@gmail.com'));
check('every success was persisted', Object.keys(state.chunks).length === 6, `${saves.length} saves`);
check('a no-op fit still leaves <name>.mp3 for the artifact',
  Object.entries(state.chunks).every(([index, chunk]) => chunk.file.endsWith(`${dubLib.chunkName(Number(index))}.mp3`)
    && fs.existsSync(path.join(work, chunk.file))),
  JSON.stringify(Object.values(state.chunks).map((chunk) => chunk.file)));
check('the state file on disk parses and holds all 6 chunks',
  JSON.parse(fs.readFileSync(stateFile, 'utf8')).chunks
  && Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).chunks).length === 6);
check('the failing chunk used 1 + 2 attempts (queue + two rounds)',
  saves.length === 6 && result.attempts >= 11, `attempts=${result.attempts}`);

/* ------------------------------------------------------------------ */
/* Rollover: the last minute runs out while a chunk is starting.      */
/* ------------------------------------------------------------------ */

console.log('\n--- rollover + slot accounting ---');
const work2 = path.join(tmp, 'work2');
fs.mkdirSync(path.join(work2, 'dub'), { recursive: true });

let made = 0;
const seen = [];
const minutes = new Map();
const rolloverDeps = {
  withProxy: (_e, fn) => fn(),
  forIdentity: () => null,
  sleep: async () => {},
  startAccount: async () => {
    made += 1;
    const email = `leak${made}@x`;
    minutes.set(email, 0);
    return {
      email, tokens: { t: email }, spaceId: 's',
      credits: { minutes: { total: 3, used: 0 }, video: { total: 5, used: 0 } },
    };
  },
  remaining: (c) => ({
    minutes: Math.max(0, c.minutes.total - c.minutes.used),
    videos: Math.max(0, c.video.total - c.video.used),
  }),
  getCredits: async (tokens) => {
    const used = minutes.get(tokens.t) || 0;
    return { minutes: { total: 3, used }, video: { total: 5, used } };
  },
  generateAddress: async () => ({ email: 'acc@x' }),
  waitForCode: async () => ({ code: '1' }),
  dubAudio: async ({ tokens, name, beforeCreate }) => {
    await beforeCreate();
    minutes.set(tokens.t, (minutes.get(tokens.t) || 0) + 1);
    const index = Number(name.replace('chunk-', ''));
    seen.push(`${index}:${tokens.t}`);
    if (index % 2 === 0) throw new Error('boom');
    return { file: '', projectId: `p${index}`, duration: 50 };
  },
  extractAudioFromMp4: async (_m, out) => { fs.writeFileSync(out, 'x'); return out; },
  fitChunkAudio: async (_r, out) => { fs.writeFileSync(out, 'x'); return out; },
};

// 9 chunks, every even index fails right after its minute is charged. A leaked
// slot would make the pool open accounts it never uses; the race at the last
// minute would make it open one and retire it again immediately.
const chunks2 = Array.from({ length: 9 }, (_, i) => ({
  index: i, start: 0, end: 50, duration: 50, file: 'c.m4a',
}));
const r2 = await dubLib.dubQueue({
  chunks: chunks2,
  cfg: { ...cfg, parallel: 2, chunkTries: 1, retryRounds: 0 },
  workDir: work2,
  state: { chunks: {} },
  saveState: () => {},
  deps: rolloverDeps,
});

check('9 projects roll over after exactly 3 accounts', r2.accountsOpened === 3 && made === 3,
  `opened ${r2.accountsOpened}, created ${made}`);
check('no account is opened and thrown away unused',
  [...minutes.entries()].every(([, used]) => used > 0), JSON.stringify([...minutes.entries()]));
check('no account is sold more minutes than it has',
  [...minutes.entries()].every(([, used]) => used === 3), JSON.stringify([...minutes.entries()]));
check('no project is created twice', seen.length === 9, seen.join(' '));
check('5 chunks failed (the even ones)', r2.failures.length === 5,
  r2.failures.map((f) => f[0]).join(','));

/* ------------------------------------------------------------------ */
/* A dub that is already on disk must never be billed twice.          */
/* ------------------------------------------------------------------ */

console.log('\n--- reuse a dub that was already downloaded ---');
const work3 = path.join(tmp, 'work3');
fs.mkdirSync(path.join(work3, 'dub'), { recursive: true });
fs.mkdirSync(path.join(work3, 'rask'), { recursive: true });
// The crash this guards against happens between the download and the state
// write, so the paid mp4 is on disk while the chunk has no state entry.
fs.writeFileSync(path.join(work3, 'rask', 'chunk-000-rask.mp4'), 'x'.repeat(2048));

let billed = 0;
const reuseDeps = {
  ...rolloverDeps,
  dubAudio: async () => { billed += 1; return { file: '', projectId: 'p', duration: 50 }; },
};
const reuseState = { chunks: {} };
const r3 = await dubLib.dubQueue({
  chunks: [{ index: 0, start: 0, end: 50, duration: 50, file: 'c.m4a' }],
  cfg: { ...cfg, parallel: 1, chunkTries: 1, retryRounds: 0, dubDir: path.join(work3, 'dub'), raskDir: path.join(work3, 'rask') },
  workDir: work3,
  state: reuseState,
  saveState: () => {},
  deps: reuseDeps,
});

check('no Rask project is created for a cached dub', billed === 0 && r3.accountsOpened === 0,
  `billed ${billed}, accounts ${r3.accountsOpened}`);
check('the cached dub is recorded as done', reuseState.chunks[0]?.projectId === 'reused' && r3.failures.length === 0,
  JSON.stringify(reuseState.chunks[0] || {}));

/* ------------------------------------------------------------------ */
/* A timeline with no dub at all must never be published as a dub.     */
/* ------------------------------------------------------------------ */

console.log('\n--- refuse to mix an undubbed timeline ---');
const pipeline = await import(pathToFileURL(path.join(repo, 'scripts/lib/pipeline.mjs')).href);
const work4 = path.join(tmp, 'work4');
fs.mkdirSync(path.join(work4, 'dub'), { recursive: true });

const plan4 = {
  input: 'source.mp4',
  target: 'fa-ir',
  duration: 100,
  isVideo: false,
  chunks: [
    { index: 0, start: 0, end: 50, duration: 50, file: 'chunks/chunk-000.m4a', hasSpeech: true },
    { index: 1, start: 50, end: 100, duration: 50, file: 'chunks/chunk-001.m4a', hasSpeech: true },
  ],
};
const cfg4 = {
  ...cfg,
  workDir: work4,
  outDir: path.join(work4, 'out'),
  dubDir: path.join(work4, 'dub'),
  reportsDir: path.join(work4, 'reports'),
  trackFile: path.join(work4, 'dubbed-full.mp3'),
  stateFile: path.join(work4, 'state.json'),
  outputName: '',
  onFail: 'original',
};

let guard = null;
try {
  await pipeline.merge(cfg4, plan4);
} catch (err) { guard = err; }
// A cancelled dub stage leaves zero dubs on disk; ON_FAIL=original would happily
// mux the source audio back and ship it as a Persian dub.
check('a mix with zero dubs is rejected instead of published',
  Boolean(guard) && /no chunk was dubbed/.test(String(guard.message)), String(guard?.message));
check('nothing is written into out/ when the guard fires',
  !fs.existsSync(path.join(work4, 'out', 'report.json')));

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nDUB TEST FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nDUB TEST OK');
