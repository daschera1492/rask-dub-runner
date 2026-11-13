#!/usr/bin/env node
/**
 * Stage 3 — put the timeline back together and publish it.
 *
 *   WORK_DIR=... node scripts/merge.mjs
 *
 * Reads work/plan.json plus every work/dub/chunk-*.mp3 the shards produced.
 * A chunk without a dub keeps its ORIGINAL audio (ON_FAIL=original), so the
 * output never has dead air; ON_FAIL=silence or ON_FAIL=error changes that.
 */

import { cfg } from './lib/config.mjs';
import { loadPlan, merge } from './lib/pipeline.mjs';

const plan = loadPlan(cfg.workDir);

merge(cfg, plan).catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
