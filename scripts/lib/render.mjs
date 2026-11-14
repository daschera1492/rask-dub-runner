/**
 * Stage 3b - render the published video at every requested size.
 *
 * merge() leaves ONE master mp4 in out/ (dubbed audio, video stream-copied from
 * the source). That file keeps the source's size and codec - a 4K AV1 download,
 * a 1080p HEVC phone clip, a 480p web rip - so it is the wrong asset for a
 * release. This stage re-encodes it into out/render/<name>-<size>p.mp4:
 *
 *   - ONE ffmpeg pass: the master is decoded once, `split` into one branch per
 *     rung, and every branch is scaled and encoded on its own (libx264, capped
 *     CRF, faststart). Encoding them in a single process keeps one decode and
 *     one disk read for the whole ladder.
 *   - The SHORT side is what a size means: 1080 on a 1920x1080 clip and 1080 on
 *     a 1080x1920 vertical one. `scale` gets a square box with
 *     `force_original_aspect_ratio=increase`, so the aspect ratio is kept and
 *     the display rotation of a phone clip cannot squash the picture.
 *   - A rung above the source's short side is skipped instead of upscaled, so a
 *     720p source renders 360/480/720 (RENDER_UPSCALE=1 overrides).
 *   - No master (audio-only source, or a merge that never ran) is not an error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sh } from './media.mjs';
import { planRenditions, formatLadder } from './ladder.mjs';
import { log, warn, setOutput } from './report.mjs';

/** Bitrate ceiling per rung, so a 3-hour source cannot fill the release. */
function caps(size) {
  if (size <= 360) return { maxrate: '900k', bufsize: '1800k' };
  if (size <= 480) return { maxrate: '1500k', bufsize: '3000k' };
  if (size <= 720) return { maxrate: '3000k', bufsize: '6000k' };
  if (size <= 1080) return { maxrate: '5500k', bufsize: '11000k' };
  return { maxrate: '9000k', bufsize: '18000k' };
}

/**
 * The master merge() wrote. report.json is the authoritative list; the fallback
 * picks the biggest mp4 in out/ so leftovers from an earlier ladder cannot win.
 */
function findMaster(outDir) {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    const master = (report.outputs || []).find((file) => /\.mp4$/i.test(file) && fs.existsSync(file));
    if (master) return master;
  } catch {
    // merge did not get far enough to write a report
  }

  if (!fs.existsSync(outDir)) return null;
  const candidates = fs
    .readdirSync(outDir)
    .filter((name) => /\.mp4$/i.test(name))
    .map((name) => path.join(outDir, name))
    .filter((file) => fs.statSync(file).isFile());

  if (!candidates.length) return null;
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

/** Display geometry: a 90 degree display matrix means the picture is portrait. */
async function probeGeometry(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_streams',
    '-of', 'json',
    file,
  ]);

  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream) return null;

  let width = Math.round(Number(stream.width) || 0);
  let height = Math.round(Number(stream.height) || 0);
  if (width < 2 || height < 2) return null;

  const side = (stream.side_data_list || []).find((entry) => Number.isFinite(Number(entry.rotation)));
  const rotated = Math.abs(Math.round(Number(side?.rotation ?? stream.tags?.rotate ?? 0))) % 180;
  if (rotated === 90) [width, height] = [height, width];

  return { width, height };
}

/** ffmpeg with its progress lines forwarded, so a long encode is not a black box. */
function ffmpegLive(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    const tail = [];
    let buffer = '';

    child.stderr.on('data', (data) => {
      buffer += data;
      const lines = buffer.split(/\r|\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        console.error(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-6).join(' | ')}`));
    });
  });
}

export async function render(cfg) {
  if (!cfg.renderSizes.length) {
    log('[render] RENDER_SIZES is off - publishing the master video unchanged');
    setOutput('renditions', '');
    return { renditions: [], outputs: [] };
  }

  const master = findMaster(cfg.outDir);
  if (!master) {
    log('[render] no master mp4 (audio-only source) - nothing to render');
    setOutput('renditions', '');
    return { renditions: [], outputs: [] };
  }

  const geometry = await probeGeometry(master);
  if (!geometry) {
    warn(`[render] ${path.basename(master)} has no readable video stream - nothing to render`);
    setOutput('renditions', '');
    return { renditions: [], outputs: [] };
  }

  const renditions = planRenditions({
    width: geometry.width,
    height: geometry.height,
    sizes: cfg.renderSizes,
    allowUpscale: cfg.renderUpscale,
  });

  if (!renditions.length) {
    const shortSide = Math.min(geometry.width, geometry.height);
    warn(
      `[render] nothing to render: source short side is ${shortSide}, requested `
      + `${cfg.renderSizes.join(',')} (RENDER_UPSCALE=1 renders the bigger rungs anyway)`,
    );
    setOutput('renditions', '');
    return { renditions: [], outputs: [] };
  }

  fs.mkdirSync(cfg.renderDir, { recursive: true });
  const stem = path.basename(master, path.extname(master));
  const outputs = renditions.map((r) => path.join(cfg.renderDir, `${stem}-${r.label}.mp4`));

  const graph = [
    `[0:v:0]split=${renditions.length}${renditions.map((_, i) => `[s${i}]`).join('')}`,
    ...renditions.map((r, i) => (
      `[s${i}]scale=w=${r.size}:h=${r.size}`
      + ':force_original_aspect_ratio=increase:force_divisible_by=2:flags=bicubic,setsar=1'
      + `[v${i}]`
    )),
  ].join(';');

  const args = [
    '-y', '-v', 'error', '-nostdin', '-stats', '-stats_period', '20',
    '-i', master,
    '-filter_complex', graph,
  ];

  renditions.forEach((r, i) => {
    const { maxrate, bufsize } = caps(r.size);
    args.push(
      '-map', `[v${i}]`,
      // merge() already produced AAC from the dubbed track: copying it avoids a
      // second lossy generation and costs no encoding time.
      '-map', '0:a:0?',
      '-c:a', 'copy',
      '-c:v', 'libx264',
      '-preset', cfg.renderPreset,
      '-crf', String(cfg.renderCrf),
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputs[i],
    );
  });

  log(`[render] ${path.basename(master)} ${geometry.width}x${geometry.height} -> `
    + renditions.map((r) => `${r.label} (${r.width}x${r.height})`).join(', '));

  const started = Date.now();
  await ffmpegLive(args);

  const produced = outputs.filter((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
  const missing = outputs.filter((file) => !produced.includes(file));
  if (missing.length) {
    warn(`[render] ffmpeg wrote no data for: ${missing.map((file) => path.basename(file)).join(', ')}`);
  }

  const mb = (file) => (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  for (const file of produced) log(`[render] ${path.basename(file)} (${mb(file)} MB)`);
  log(`[render] ${produced.length} rendition(s) in ${minutes} min`);

  setOutput('renditions', produced.map((file) => path.basename(file)).join(','));
  setOutput('ladder', formatLadder(renditions.filter((_, i) => produced.includes(outputs[i]))));

  return { renditions, outputs: produced };
}
