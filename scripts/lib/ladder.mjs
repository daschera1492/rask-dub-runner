/**
 * Resolution ladder for the release (`scripts/lib/render.mjs`).
 *
 * The merge stage puts the dubbed audio back on the ORIGINAL video with
 * `-c:v copy`, so the master keeps whatever the source was: a 4K AV1 download,
 * a 1080p HEVC phone clip, a 480p web rip. A release should not ship only that
 * one file — it ships the usual sizes (360p / 480p / 720p / 1080p), which means
 * the master is re-encoded once per rung.
 *
 * The maths lives here, away from ffmpeg and the filesystem, so `npm test` can
 * pin it down without a runner.
 */

/** Sizes rendered by default; `RENDER_SIZES` replaces the list. */
export const DEFAULT_SIZES = [360, 480, 720, 1080];

const MIN_SIZE = 144;
const MAX_SIZE = 4320;

/** Values of `RENDER_SIZES` that mean "publish the master only". */
const OFF = new Set(['', 'off', 'none', 'no', 'false', '0']);

/** libx264 with yuv420p refuses odd dimensions. */
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * `"360p, 480p 720,1080"` -> `[360, 480, 720, 1080]`.
 *
 * `undefined` keeps the default ladder; `''` / `off` disables rendering
 * entirely. Words and out-of-range numbers are dropped, duplicates collapse,
 * the result is ascending.
 */
export function parseSizes(raw, fallback = DEFAULT_SIZES) {
  if (raw === undefined || raw === null) return [...fallback];

  const text = String(raw).trim().toLowerCase();
  if (OFF.has(text)) return [];

  const sizes = new Set();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const size = Math.round(Number(token.replace(/p$/, '')));
    if (!Number.isFinite(size) || size < MIN_SIZE || size > MAX_SIZE) continue;
    sizes.add(size);
  }
  return [...sizes].sort((a, b) => a - b);
}

/**
 * Turn the source geometry into concrete rungs.
 *
 * `size` is the SHORT side of the output: 1080 on a 1920x1080 landscape clip
 * and 1080 on a 1080x1920 vertical one (a "1080p" Short), which is what the
 * label means to a viewer. The long side follows the source aspect ratio and is
 * rounded to an even number. ffmpeg does the same thing on its own with a square
 * `scale` box, this is only for logs and tests.
 *
 * A rung above the source's short side is dropped instead of upscaled: a 720p
 * source yields 360/480/720. Pass `allowUpscale` to render them anyway.
 */
export function planRenditions({ width, height, sizes = DEFAULT_SIZES, allowUpscale = false }) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (w < 2 || h < 2) return [];

  const portrait = h > w;
  const shortSide = Math.min(w, h);
  const renditions = [];
  const seen = new Set();

  for (const size of sizes) {
    if (!allowUpscale && size > shortSide) continue;

    const outWidth = portrait ? even(size) : even((size * w) / h);
    const outHeight = portrait ? even((size * h) / w) : even(size);

    // Two requested sizes can collapse onto the same frame on an extreme
    // aspect ratio; encoding it twice would only burn runner minutes.
    const key = `${outWidth}x${outHeight}`;
    if (seen.has(key)) continue;
    seen.add(key);

    renditions.push({ size, label: `${size}p`, width: outWidth, height: outHeight });
  }

  return renditions;
}

/** `[{label: '360p'}, {label: '720p'}]` -> `"360p,720p"` (GitHub step output). */
export function formatLadder(renditions) {
  return (renditions || []).map((rendition) => rendition.label).join(',');
}
