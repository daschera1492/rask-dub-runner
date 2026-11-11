#!/usr/bin/env node
/**
 * Summarise a dub run from $WORK_DIR/state.json.
 * Read-only: it never changes a run, it only tells you what happened.
 *
 *   node scripts/report.mjs
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORK = resolve(process.env.WORK_DIR || 'work');
const STATE = join(WORK, 'state.json');
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '—';
const clock = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;

function finish() {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch { /* noop */ }
  }
}

if (!existsSync(STATE)) {
  say('### run report');
  say();
  say('_no `state.json` — the run produced nothing (it failed before or during dubbing)._');
  finish();
  process.exit(0);
}

let st;
try {
  st = JSON.parse(readFileSync(STATE, 'utf8'));
} catch (e) {
  say('### run report');
  say();
  say(`_could not parse state.json: ${e.message}_`);
  finish();
  process.exit(0);
}

const chunks = st.chunks || {};
const plan = Array.isArray(st.plan) && st.plan.length
  ? st.plan
  : Object.keys(chunks).map(Number).sort((a, b) => a - b)
      .map((i) => ({ index: i, start: chunks[i].start ?? 0, end: chunks[i].end ?? 0, duration: chunks[i].duration ?? 0 }));

const done = plan.filter((c) => chunks[c.index]?.done);
const missing = plan.filter((c) => !chunks[c.index]?.done);
const audioTotal = plan.reduce((a, c) => a + (c.duration || 0), 0);
const audioDone = done.reduce((a, c) => a + (c.duration || 0), 0);
const raskSecs = done.map((c) => chunks[c.index].seconds || 0).sort((a, b) => a - b);
const raskSum = raskSecs.reduce((a, b) => a + b, 0);
const median = raskSecs.length ? raskSecs[Math.floor(raskSecs.length / 2)] : NaN;

// A project always costs one minute of the free allowance, whatever its length.
const billed = plan.length;
const shortOnes = plan.filter((c) => (c.duration || 0) < 40);
const shortWaste = shortOnes.reduce((a, c) => a + Math.max(0, 60 - (c.duration || 0)), 0);

say('### run report');
say();
say('| metric | value |');
say('| --- | --- |');
say(`| source duration | ${fmt(st.source?.duration ?? audioTotal)}s |`);
say(`| chunks planned | ${plan.length} |`);
say(`| chunks done | **${done.length}** (${fmt((done.length / Math.max(1, plan.length)) * 100, 0)}%) |`);
say(`| chunks missing | **${missing.length}** |`);
say(`| audio covered | ${fmt(audioDone)}s / ${fmt(audioTotal)}s |`);
say(`| Rask project time | total ${clock(raskSum)}, median ${clock(median)}, max ${clock(Math.max(0, ...raskSecs))} |`);
say(`| quota billed | ~${billed} min (one per project, regardless of length) |`);
say(`| short chunks (<40s) | ${shortOnes.length} → ~${clock(shortWaste)} of quota wasted |`);
say(`| accounts opened | ~${Math.ceil(billed / 3)} (registry keeps no counter) |`);
say();

if (missing.length) {
  say(`**missing:** ${missing.map((c) => c.index).join(', ')}`);
  say();
}

const slowest = done
  .map((c) => ({ i: c.index, s: chunks[c.index].seconds || 0, d: c.duration }))
  .sort((a, b) => b.s - a.s)
  .slice(0, 5);
if (slowest.length) {
  say('**slowest chunks:**');
  say();
  say('| chunk | audio | Rask |');
  say('| --- | --- | --- |');
  for (const r of slowest) say(`| ${r.i} | ${fmt(r.d)}s | ${clock(r.s)} |`);
  say();
}

const rows = plan.slice(0, 60);
say('<details><summary>per-chunk</summary>');
say();
say('| # | start | audio | Rask | status |');
say('| --- | --- | --- | --- | --- |');
for (const c of rows) {
  const ch = chunks[c.index];
  say(`| ${c.index} | ${fmt(c.start)}s | ${fmt(c.duration)}s | ${ch?.seconds ? clock(ch.seconds) : '—'} | ${ch?.done ? 'done' : '**missing**'} |`);
}
if (plan.length > rows.length) say(`| … | | | | ${plan.length - rows.length} more |`);
say();
say('</details>');

finish();
