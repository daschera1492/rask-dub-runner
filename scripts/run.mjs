#!/usr/bin/env node
/**
 * Rask.ai dubbing runner — single machine.
 *
 *   INPUT_URL=... TARGET_LANG=Persian node scripts/run.mjs
 *
 * Runs all three stages in one process:
 *
 * 1. split the source into <=1 minute chunks (audio only, cut in pauses),
 * 2. one throw-away Rask account per three chunks (emailnator Gmail + Cognito),
 * 3. send only the audio chunk, wait for the dub, download it,
 * 4. fit every dubbed chunk to its exact slot, concatenate the timeline and mux
 *    it onto the ORIGINAL video with `-c:v copy` — the picture never leaves the
 *    machine, and the result carries no Rask watermark.
 * 5. re-encode that master into the release ladder (360p/480p/720p/1080p by
 *    default, RENDER_SIZES changes it, `off` keeps the master only).
 *
 * A chunk that cannot be dubbed keeps its original audio instead of silence;
 * failed chunks get two extra passes on fresh accounts first (RETRY_ROUNDS).
 *
 * In CI the same stages run as separate jobs (prepare → N dub shards → merge),
 * see scripts/prepare.mjs, scripts/dub-worker.mjs and scripts/merge.mjs.
 */

import { cfg } from './lib/config.mjs';
import { prepare, dubPlan, merge } from './lib/pipeline.mjs';
import { render } from './lib/render.mjs';
import { log, warn } from './lib/report.mjs';

async function main() {
  const plan = await prepare(cfg);

  const report = await dubPlan(cfg, plan, { shard: null });
  if (report.missing.length) {
    warn(`[dub] ${report.missing.length} chunk(s) still without a dub after all retries: ${report.missing.join(', ')}`);
    warn(`[dub] ON_FAIL=${cfg.onFail} — these spans keep the ${cfg.onFail === 'original' ? 'source audio' : cfg.onFail}`);
  }

  const out = await merge(cfg, plan);
  log(`[done] ${out.outputs.join(' + ')}`);

  // Stage 3b: the same ladder the workflow publishes (RENDER_SIZES=off skips it).
  await render(cfg);
  return out;
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
