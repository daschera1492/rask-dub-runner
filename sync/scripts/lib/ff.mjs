import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  if (process.env[envKey]) return process.env[envKey];

  const local = join(ROOT, 'tools', 'ffmpeg', 'bin', exe);
  if (existsSync(local)) return local;

  return exe; // fall back to PATH
}

export const FFMPEG = resolveBin('ffmpeg');
export const FFPROBE = resolveBin('ffprobe');

/** Run a binary, capture stdout/stderr, reject with the tail of stderr on failure. */
export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve({ out, err });
      const tail = err.trim().split(/\r?\n/).slice(-25).join('\n');
      reject(new Error(`${basename(bin)} exited ${code}\n  args: ${args.join(' ')}\n${tail}`));
    });
  });
}

/** Count decoded audio samples of `file` at SR/CH — ground truth, ignores container padding. */
export function decodeSamples(bin, file, sr, ch) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', String(ch), '-ar', String(sr), '-'], { windowsHide: true });
    let bytes = 0;
    let err = '';
    p.stdout.on('data', (d) => { bytes += d.length; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(bytes / (2 * ch)) : reject(new Error(`decode failed: ${err.slice(-800)}`)));
  });
}

export async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  try {
    return JSON.parse(out || '{}');
  } catch {
    throw new Error(`ffprobe returned unparsable output for ${file}`);
  }
}
