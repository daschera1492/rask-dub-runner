/**
 * Offline test for the release ladder (`scripts/lib/ladder.mjs`).
 *
 * Pure maths only: which sizes survive a `RENDER_SIZES` string, how the aspect
 * ratio is kept for landscape and vertical clips, and the "never upscale" rule.
 * No ffmpeg, no network, no filesystem.
 *
 *   node test/ladder.test.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const ladder = await import(pathToFileURL(path.join(repo, 'scripts/lib/ladder.mjs')).href);

const failures = [];
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${label}${detail ? ` (${detail})` : ''}`);
};
const eq = (label, actual, expected) => check(
  label,
  JSON.stringify(actual) === JSON.stringify(expected),
  `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
);
const sizes = (raw, fallback) => ladder.parseSizes(raw, fallback);
const rungs = (renditions) => renditions.map((r) => `${r.label}=${r.width}x${r.height}`);

/* ------------------------------------------------------------------ */
/* RENDER_SIZES parsing                                                */
/* ------------------------------------------------------------------ */

eq('no value -> default ladder', rungs(ladder.planRenditions({
  width: 1920,
  height: 1080,
  sizes: ladder.DEFAULT_SIZES,
})), ['360p=640x360', '480p=854x480', '720p=1280x720', '1080p=1920x1080']);

eq('default list', ladder.DEFAULT_SIZES, [360, 480, 720, 1080]);
eq('undefined keeps the default', sizes(undefined), [360, 480, 720, 1080]);
eq('empty disables', sizes(''), []);
eq('off disables', sizes('off'), []);
eq('OFF is case-insensitive', sizes(' OFF '), []);
eq('comma separated, with p suffix', sizes('360p,480p,720p,1080p'), [360, 480, 720, 1080]);
eq('spaces and semicolons work too', sizes('1080p 360; 480, 720'), [360, 480, 720, 1080]);
eq('duplicates collapse and order is ascending', sizes('720,360,720,1080,360'), [360, 720, 1080]);
eq('junk and out-of-range are dropped', sizes('hd,100,360,99999'), [360]);
eq('a custom list is honoured', sizes('240,1440'), [240, 1440]);

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

eq('1080p source -> full ladder', rungs(ladder.planRenditions({ width: 1920, height: 1080 })),
  ['360p=640x360', '480p=854x480', '720p=1280x720', '1080p=1920x1080']);

eq('4K source is downscaled, never upscaled past 1080', rungs(ladder.planRenditions({ width: 3840, height: 2160 })),
  ['360p=640x360', '480p=854x480', '720p=1280x720', '1080p=1920x1080']);

eq('720p source stops at 720p', rungs(ladder.planRenditions({ width: 1280, height: 720 })),
  ['360p=640x360', '480p=854x480', '720p=1280x720']);

eq('480p source stops at 480p', rungs(ladder.planRenditions({ width: 854, height: 480 })),
  ['360p=640x360', '480p=854x480']);

eq('allowUpscale renders the missing rung', rungs(ladder.planRenditions({
  width: 1280,
  height: 720,
  sizes: [1080],
  allowUpscale: true,
})), ['1080p=1920x1080']);

eq('vertical Short keeps the short side', rungs(ladder.planRenditions({ width: 1080, height: 1920 })),
  ['360p=360x640', '480p=480x854', '720p=720x1280', '1080p=1080x1920']);

eq('cinematic 2.39:1 keeps the width it needs', rungs(ladder.planRenditions({ width: 1920, height: 804 })),
  ['360p=860x360', '480p=1146x480', '720p=1720x720']);

eq('square source', rungs(ladder.planRenditions({ width: 1000, height: 1000, sizes: [360, 480] })),
  ['360p=360x360', '480p=480x480']);

eq('odd geometry still lands on even numbers',
  ladder.planRenditions({ width: 1918, height: 1078 }).every((r) => r.width % 2 === 0 && r.height % 2 === 0),
  true);

eq('every rung is even for every shape',
  [[3840, 2160], [1080, 1920], [1918, 1078], [1440, 1080], [640, 360]]
    .every(([width, height]) => ladder.planRenditions({ width, height })
      .every((r) => r.width % 2 === 0 && r.height % 2 === 0)),
  true);

eq('no geometry -> nothing to render', ladder.planRenditions({ width: 0, height: 0 }), []);
eq('no sizes -> nothing to render', ladder.planRenditions({ width: 1920, height: 1080, sizes: [] }), []);

/* ------------------------------------------------------------------ */
/* Step output                                                         */
/* ------------------------------------------------------------------ */

eq('ladder label for GITHUB_OUTPUT', ladder.formatLadder(ladder.planRenditions({ width: 1920, height: 1080 })),
  '360p,480p,720p,1080p');
eq('empty ladder label', ladder.formatLadder([]), '');

if (failures.length) {
  console.error(`\nLADDER TEST FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nLADDER TEST OK');
