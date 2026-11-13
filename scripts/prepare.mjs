#!/usr/bin/env node
/**
 * Stage 1 — download the source, find the cuts, write work/plan.json and the
 * cut audio chunks. Runs once per workflow.
 *
 *   INPUT_URL=... TARGET_LANG=Persian PARALLEL_RUNNERS=6 node scripts/prepare.mjs
 */

import { cfg } from './lib/config.mjs';
import { prepare } from './lib/pipeline.mjs';

prepare(cfg).catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
