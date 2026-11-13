#!/usr/bin/env node
/**
 * Stage 2 — dub the chunks of one shard.
 *
 *   SHARD=0 WORK_DIR=... node scripts/dub-worker.mjs
 *
 * Every shard runs on its own runner (its own IP, its own emailnator/Rask
 * budget), so N runners finish the timeline in roughly 1/N of the wall time.
 * Without SHARD it dubs every chunk that is still missing, which is handy
 * locally.
 */

import { cfg } from './lib/config.mjs';
import { loadPlan, dubPlan } from './lib/pipeline.mjs';

const plan = loadPlan(cfg.workDir);

dubPlan(cfg, plan).then((report) => {
  if (report.missing.length) {
    // Not a failure: the merge stage puts the original audio back for those.
    console.log(`[dub] ${report.missing.length} chunk(s) could not be dubbed: ${report.missing.join(', ')}`);
  }
}).catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
