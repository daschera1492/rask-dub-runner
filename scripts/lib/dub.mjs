/**
 * Rask account pool.
 *
 * A fresh signup carries 3 dubbing minutes / 5 projects and every project is
 * billed as a whole minute, so one account dubs three chunks. This module opens
 * accounts on demand, keeps `parallel` projects in flight on the current one,
 * and never overshoots the minutes the server says are left.
 *
 * Failure policy (learned from Actions run 43106519120):
 *
 *  - Rask sometimes parks a project at `transcription_started` forever, and
 *    every project on that same account parks with it. Retrying on such an
 *    account only burns more minutes, so it is retired at once and the chunk
 *    moves to a fresh account.
 *  - A chunk that still fails gets `RETRY_ROUNDS` extra passes at the very end
 *    of the queue, each starting on a new account.
 *  - The project slot (`inFlight`) is released in a `finally`, so a failed
 *    project can never leave the account looking full.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as rask from './rask.mjs';
import * as emailnator from './emailnator.mjs';
import * as proxy from './proxy.mjs';
import { withProxy, sleep } from './http.mjs';
import { fitChunkAudio, extractAudioFromMp4 } from './media.mjs';
import { log } from './report.mjs';

export const chunkName = (index) => `chunk-${String(index).padStart(3, '0')}`;

/** Absolute path of a chunk's source-audio file, which the plan stores relative. */
export const planFile = (workDir, rel) => (path.isAbsolute(rel) ? rel : path.join(workDir, rel));

/** The finished dub for this chunk, or null. */
export function dubbedFile(workDir, index) {
  const file = path.join(workDir, 'dub', `${chunkName(index)}.mp3`);
  return fs.existsSync(file) ? file : null;
}

/**
 * @param {object}   options
 * @param {Array}    options.chunks    chunks to dub (already filtered/sharded)
 * @param {object}   options.cfg       parsed config (see config.mjs)
 * @param {string}   options.workDir
 * @param {object}   options.state     { chunks: { [index]: {...} } }
 * @param {Function} options.saveState
 * @param {object}   [options.deps]    overrides for tests (fake Rask/emailnator)
 * @returns {Promise<{accountsOpened:number, attempts:number, failures:Array<[number,string]>}>}
 */
export async function dubQueue({ chunks, cfg, workDir, state, saveState, deps = {} }) {
  // Every network and media call goes through this table, so a test can drive
  // the queue (stalls, exhausted minutes, hard failures) without Rask.
  const api = {
    startAccount: rask.startAccount,
    remaining: rask.remaining,
    getCredits: rask.getCredits,
    dubAudio: rask.dubAudio,
    generateAddress: emailnator.generateAddress,
    waitForCode: emailnator.waitForCode,
    forIdentity: proxy.forIdentity,
    withProxy,
    sleep,
    extractAudioFromMp4,
    fitChunkAudio,
    ...deps,
  };

  const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]));
  const cap = cfg.maxAccounts > 0 ? cfg.maxAccounts : Math.ceil(chunks.length / 3) + 4;

  let account = null;
  let accountsOpened = 0;
  let attempts = 0;
  let serverLeft = { minutes: 0, videos: 0 };
  // Reservations are counted per account object, so a rollover can never mix
  // the old account's in-flight projects into the new account's budget.
  const reserved = new Map();
  // Remaining projects for an account, decremented the moment a slot is taken.
  // The server snapshot lags (it only changes after a project finishes), so on
  // a burst of completions the estimate alone would sell the same minute twice
  // and create a project the account cannot pay for.
  const budget = new Map();
  const failures = new Map();

  const inFlight = (acc = account) => (acc ? reserved.get(acc) || 0 : 0);

  /**
   * Free project slots on the current account: the server's numbers, capped by
   * what this worker has already promised away.
   */
  const slots = () => Math.min(
    serverLeft.minutes,
    serverLeft.videos,
    account ? budget.get(account) || 0 : 0,
  );

  const retire = (why) => {
    if (!account) return;
    log(`[account] retiring ${account.email}: ${why}`);
    account = null;
    serverLeft = { minutes: 0, videos: 0 };
  };

  const openAccount = async () => {
    if (accountsOpened >= cap) {
      throw new Error(`hit the account cap (${cap}) with ${chunks.length} chunk(s) in this shard`);
    }
    accountsOpened += 1;
    // One sticky residential exit for this account's whole life: signup, every
    // API call, and the code polling. Media stays direct.
    const exit = api.forIdentity(crypto.randomUUID());
    log(`[account] opening #${accountsOpened}${exit ? ` via ${exit.label}` : ' (direct IP)'}`);
    const acc = await api.withProxy(exit, () => api.startAccount({
      emailnator: { generateAddress: api.generateAddress, waitForCode: api.waitForCode },
      otpWaitSeconds: cfg.otpWait,
    }));
    acc.proxy = exit;
    account = acc;
    reserved.set(acc, 0);
    serverLeft = api.remaining(acc.credits);
    budget.set(acc, Math.min(serverLeft.minutes, serverLeft.videos));
    return acc;
  };

  // Parallel workers must share ONE signup at a time: emailnator rate-limits
  // bursts, and simultaneous signups only burn addresses.
  let accountPromise = null;
  const ensureAccount = async () => {
    if (account) return account;
    if (!accountPromise) {
      accountPromise = openAccount().finally(() => { accountPromise = null; });
    }
    return accountPromise;
  };

  const creditsLeft = async (acc) => api.remaining(await api.withProxy(acc.proxy, () => api.getCredits(acc.tokens)));

  /** An error that means "this account is spent, a fresh one is already open". */
  const freshAccountError = () => {
    const err = new Error('account out of minutes — retrying on the fresh account');
    err.freshAccount = true;
    return err;
  };

  /**
   * Retire the account we looked at, but only if it is still the current one.
   * Parallel workers hit the last minute at the same moment; without this check
   * the second one would retire the account the first one just opened.
   */
  const retireIfCurrent = (observed) => {
    if (account && account === observed) retire('out of minutes');
  };

  /**
   * Take one of `acc`'s minutes. Waits while that account's other projects are
   * running, and refuses to charge an account the caller is not using: another
   * worker may have retired it while this chunk was uploading.
   */
  const reserveSlot = async (acc) => {
    for (let i = 0; i < 90; i++) {
      if (account !== acc) throw freshAccountError();
      if (slots() >= 1) {
        reserved.set(acc, inFlight(acc) + 1);
        budget.set(acc, (budget.get(acc) || 0) - 1);
        return;
      }
      if (inFlight(acc) === 0) {
        retireIfCurrent(acc);
        // Nothing was charged: the caller may retry this chunk on a fresh
        // account without losing upload work.
        throw freshAccountError();
      }
      await api.sleep(2000);
    }
    retireIfCurrent(acc);
    throw freshAccountError();
  };

  /**
   * The upload is free, but a chunk uploaded to an account that cannot create a
   * project is wasted work (and, before this check, a four-minute wait).
   */
  const waitForRoom = async () => {
    const observed = account;
    for (let i = 0; i < 90; i++) {
      if (slots() >= 1) return;
      if (inFlight() === 0) {
        retireIfCurrent(observed);
        await ensureAccount();
        return;
      }
      await api.sleep(2000);
    }
    retireIfCurrent(observed);
    await ensureAccount();
  };

  // Turn whatever Rask returned into the fitted chunk the merge expects, then
  // persist it. Shared by the fresh call and the cached-file path below.
  const finishDub = async (chunk, name, { file, projectId, duration }, started) => {
    const raw = await api.extractAudioFromMp4(file, path.join(cfg.dubDir, `${name}-raw.mp3`));
    const fitted = path.join(cfg.dubDir, `${name}.mp3`);
    await api.fitChunkAudio(raw, fitted, chunk.duration, { index: chunk.index });
    // `fitChunkAudio` may skip the re-encode when the timing already matches.
    // The merge stage and the shard artifact only know `<name>.mp3`, and the
    // `-raw.mp3` intermediate is excluded from the artifact, so make sure the
    // normalised file always exists.
    if (!fs.existsSync(fitted)) {
      fs.mkdirSync(cfg.dubDir, { recursive: true });
      fs.copyFileSync(raw, fitted);
    }
    const out = fitted;

    state.chunks[chunk.index] = {
      file: path.relative(workDir, out),
      done: true,
      start: chunk.start,
      end: chunk.end,
      duration: chunk.duration,
      projectId,
      raskDuration: duration,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    saveState(state);
    log(`[${name}] ready in ${state.chunks[chunk.index].seconds}s`);
  };

  const dubOne = async (chunk) => {
    const name = chunkName(chunk.index);

    // A dub that was already downloaded is already paid for. If anything died
    // between the download and the state write (crash, cancel, full disk), reuse
    // the file instead of billing a second Rask project for the same chunk.
    try {
      const cached = path.join(cfg.raskDir, `${name}-rask.mp4`);
      if (fs.statSync(cached).size > 1024) {
        log(`[${name}] reusing the dub already downloaded`);
        await finishDub(chunk, name, { file: cached, projectId: 'reused', duration: 0 }, Date.now());
        return;
      }
    } catch { /* nothing cached */ }

    // An account can run out between `waitForRoom` and the project creation,
    // and the reservation is the only paid call. Nothing has been spent when it
    // fails, so start over on the fresh account instead of failing the chunk.
    for (let attempt = 1; ; attempt++) {
      await ensureAccount();
      await waitForRoom();

      const acc = account;
      log(`[${name}] ${chunk.duration.toFixed(2)}s -> Rask (${slots()} free slot(s) on ${acc.email})`);
      const started = Date.now();
      let tookSlot = false;

      try {
        const result = await api.withProxy(acc.proxy, () => api.dubAudio({
          tokens: acc.tokens,
          spaceId: acc.spaceId,
          audioFile: planFile(workDir, chunk.file),
          name,
          dstLang: cfg.target,
          prompt: cfg.translationPrompt,
          workDir: cfg.raskDir,
          // Upload is free; this is what actually costs a minute.
          beforeCreate: async () => {
            await reserveSlot(acc);
            tookSlot = true;
          },
        }));

        await finishDub(chunk, name, result, started);
        return;
      } catch (err) {
        // A parked project means the whole account is unusable: stop spending
        // minutes on it and let the caller try a fresh one right away. The flag
        // is set even when another worker already retired it, so this chunk
        // does not sit out the 15s backoff for an account that is gone.
        if (err?.accountSuspect) {
          if (account === acc) {
            retire(`project ${err.stalled ? `stalled at "${err.status || 'unknown'}"` : 'never finished'}`);
          }
          err.freshAccount = true;
        }
        if (err?.freshAccount && !tookSlot && attempt < 3) {
          log(`[${name}] ${acc.email} was already spent — moving to a fresh account before the project starts`);
          continue;
        }
        throw err;
      } finally {
        // Always release the slot, even when the project failed mid-flight.
        if (tookSlot) {
          reserved.set(acc, Math.max(0, (reserved.get(acc) || 0) - 1));
          // Refresh this account's budget — but only if it is still the current
          // one. A late answer for a retired account must never overwrite the
          // fresh account's numbers (that used to retire brand-new accounts).
          const snapshot = await creditsLeft(acc).catch(() => null);
          if (snapshot && account === acc) serverLeft = snapshot;
        }
      }
    }
  };

  const runPass = async (list, { tries }) => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const chunk = list[cursor++];
        for (let attempt = 1; attempt <= tries; attempt++) {
          attempts += 1;
          try {
            await dubOne(chunk);
            failures.delete(chunk.index);
            break;
          } catch (err) {
            const message = String(err?.message || err);
            const short = message.slice(0, 180);
            if (attempt < tries) {
              if (err?.freshAccount) {
                log(`[chunk ${chunk.index}] attempt ${attempt}/${tries} failed (${short}) — switching to a fresh account`);
              } else {
                log(`[chunk ${chunk.index}] attempt ${attempt}/${tries} failed (${short}); retrying in ${15 * attempt}s`);
                await api.sleep(15_000 * attempt);
              }
              continue;
            }
            failures.set(chunk.index, message.slice(0, 300));
            log(`[chunk ${chunk.index}] failed after ${tries} attempt(s): ${short}`);
          }
        }
      }
    };
    const width = Math.min(cfg.parallel, Math.max(1, list.length));
    await Promise.all(Array.from({ length: width }, worker));
  };

  await runPass(chunks, { tries: cfg.chunkTries });

  // Second chance for everything that failed: one more pass per round, always
  // starting on a brand-new account.
  for (let round = 1; round <= cfg.retryRounds; round++) {
    if (!failures.size) break;
    const again = [...failures.keys()].map((index) => byIndex.get(index)).filter(Boolean);
    log(`[retry] round ${round}/${cfg.retryRounds}: ${again.length} failed chunk(s) on fresh account(s)`);
    retire('starting a retry round');
    await runPass(again, { tries: 1 });
  }

  return {
    accountsOpened,
    attempts,
    failures: [...failures.entries()].sort((a, b) => a[0] - b[0]),
  };
}
