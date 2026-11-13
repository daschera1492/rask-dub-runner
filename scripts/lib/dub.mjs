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
 * @returns {Promise<{accountsOpened:number, attempts:number, failures:Array<[number,string]>}>}
 */
export async function dubQueue({ chunks, cfg, workDir, state, saveState }) {
  const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]));
  const cap = cfg.maxAccounts > 0 ? cfg.maxAccounts : Math.ceil(chunks.length / 3) + 4;

  let account = null;
  let accountsOpened = 0;
  let attempts = 0;
  let serverLeft = { minutes: 0, videos: 0 };
  let inFlight = 0;
  const failures = new Map();

  /** Free project slots on the current account, minus the ones already running. */
  const slots = () => Math.min(serverLeft.minutes, serverLeft.videos) - inFlight;

  const retire = (why) => {
    if (!account) return;
    log(`[account] retiring ${account.email}: ${why}`);
    account = null;
    serverLeft = { minutes: 0, videos: 0 };
    inFlight = 0;
  };

  const openAccount = async () => {
    if (accountsOpened >= cap) {
      throw new Error(`hit the account cap (${cap}) with ${chunks.length} chunk(s) in this shard`);
    }
    accountsOpened += 1;
    // One sticky residential exit for this account's whole life: signup, every
    // API call, and the code polling. Media stays direct.
    const exit = proxy.forIdentity(crypto.randomUUID());
    log(`[account] opening #${accountsOpened}${exit ? ` via ${exit.label}` : ' (direct IP)'}`);
    const acc = await withProxy(exit, () => rask.startAccount({
      emailnator,
      otpWaitSeconds: cfg.otpWait,
    }));
    acc.proxy = exit;
    account = acc;
    serverLeft = rask.remaining(acc.credits);
    inFlight = 0;
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

  const creditsLeft = async (acc) => rask.remaining(await withProxy(acc.proxy, () => rask.getCredits(acc.tokens)));

  /** Take one of the account's minutes. Waits while other projects are running. */
  const reserveSlot = async () => {
    for (let i = 0; i < 90; i++) {
      if (slots() >= 1) {
        inFlight += 1;
        return;
      }
      if (inFlight === 0) {
        retire('out of minutes');
        throw new Error('retry on a fresh account');
      }
      await sleep(2000);
    }
    retire('waited too long for a free slot');
    throw new Error('retry on a fresh account');
  };

  /**
   * The upload is free, but a chunk uploaded to an account that cannot create a
   * project is wasted work (and, before this check, a four-minute wait).
   */
  const waitForRoom = async () => {
    for (let i = 0; i < 90; i++) {
      if (slots() >= 1) return;
      if (inFlight === 0) {
        retire('out of minutes');
        await ensureAccount();
        return;
      }
      await sleep(2000);
    }
    retire('waited too long for a free slot');
    await ensureAccount();
  };

  const dubOne = async (chunk) => {
    const name = chunkName(chunk.index);
    await ensureAccount();
    await waitForRoom();

    const acc = account;
    log(`[${name}] ${chunk.duration.toFixed(2)}s -> Rask (${slots()} free slot(s) on ${acc.email})`);
    const started = Date.now();
    let reserved = false;

    try {
      const result = await withProxy(acc.proxy, () => rask.dubAudio({
        tokens: acc.tokens,
        spaceId: acc.spaceId,
        audioFile: planFile(workDir, chunk.file),
        name,
        dstLang: cfg.target,
        workDir: cfg.raskDir,
        // Upload is free; this is what actually costs a minute.
        beforeCreate: async () => {
          await reserveSlot();
          reserved = true;
        },
      }));

      const raw = await extractAudioFromMp4(result.file, path.join(cfg.dubDir, `${name}-raw.mp3`));
      const fitted = path.join(cfg.dubDir, `${name}.mp3`);
      const used = await fitChunkAudio(raw, fitted, chunk.duration, { index: chunk.index });
      const file = fs.existsSync(fitted) ? fitted : used;

      state.chunks[chunk.index] = {
        file: path.relative(workDir, file),
        done: true,
        start: chunk.start,
        end: chunk.end,
        duration: chunk.duration,
        projectId: result.projectId,
        raskDuration: result.duration,
        seconds: Math.round((Date.now() - started) / 1000),
      };
      saveState();
      log(`[${name}] ready in ${state.chunks[chunk.index].seconds}s`);
    } catch (err) {
      // A parked project means the whole account is unusable: stop spending
      // minutes on it and let the caller try a fresh one right away.
      if (err?.accountSuspect && account === acc) {
        retire(`project ${err.stalled ? `stalled at "${err.status || 'unknown'}"` : 'never finished'}`);
        err.freshAccount = true;
      }
      throw err;
    } finally {
      // Always release the slot, even when the project failed mid-flight.
      if (reserved) inFlight = Math.max(0, inFlight - 1);
      if (reserved && account === acc) {
        try {
          serverLeft = await creditsLeft(acc);
        } catch { /* keep the previous estimate */ }
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
                await sleep(15_000 * attempt);
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
