#!/usr/bin/env node
/**
 * Stage 3b - render the release video at every requested size.
 *
 *   WORK_DIR=... RENDER_SIZES=360,480,720,1080 node scripts/render.mjs
 *
 * Reads the master mp4 merge wrote (out/report.json points at it) and fills
 * out/render/<name>-<size>p.mp4. See scripts/lib/render.mjs for the details;
 * `RENDER_SIZES=off` publishes the master untouched.
 */

import { cfg } from './lib/config.mjs';
import { render } from './lib/render.mjs';

render(cfg).catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
