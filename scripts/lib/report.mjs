/**
 * Tiny reporting helpers: one log format for every stage, plus the two files
 * GitHub Actions reads (step outputs and the job summary).
 */

import fs from 'node:fs';

export const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
export const warn = (msg) => console.warn(`${new Date().toISOString()} ${msg}`);

export function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value ?? ''}\n`);
}

export function summary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Human-readable seconds → "1m 07s". */
export function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
