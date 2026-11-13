/**
 * The plan is the contract between the three stages:
 *
 *   prepare     writes work/plan.json + work/chunks/*
 *   dub-worker  reads it, dubs its shard, writes work/dub/*
 *   merge       reads it, collects every shard, muxes the final files
 *
 * Section paths are stored relative to WORK_DIR so the same plan works on any
 * runner (GitHub's $RUNNER_TEMP is identical across jobs, but a local run and a
 * cloud run are not).
 */

import fs from 'node:fs';
import path from 'node:path';

const PLAN_NAME = 'plan.json';

export const planPath = (workDir) => path.join(workDir, PLAN_NAME);

export function loadPlan(workDir) {
  const file = planPath(workDir);
  if (!fs.existsSync(file)) {
    throw new Error(`no plan at ${file} — run the prepare stage (scripts/prepare.mjs) first`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function savePlan(workDir, plan) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(planPath(workDir), JSON.stringify(plan, null, 2));
}

/**
 * Spread the chunks over N shards while keeping the total audio per shard as
 * even as possible (a long chunk costs one account minute, so balancing by
 * seconds also balances by spend).
 */
export function assignShards(chunks, shards) {
  const count = Math.max(1, Math.min(shards, Math.max(1, chunks.length)));
  const bins = Array.from({ length: count }, (_, i) => ({ shard: i, seconds: 0, items: [] }));

  for (const chunk of [...chunks].sort((a, b) => b.duration - a.duration)) {
    const bin = bins.reduce((lowest, b) => (b.seconds < lowest.seconds ? b : lowest), bins[0]);
    bin.items.push(chunk.index);
    bin.seconds += chunk.duration;
  }

  return {
    shards: count,
    assign: bins.map((b) => ({
      shard: b.shard,
      seconds: Math.round(b.seconds * 100) / 100,
      items: b.items.sort((a, z) => a - z),
    })),
  };
}
