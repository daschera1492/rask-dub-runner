/**
 * One place for every environment knob, so the standalone runner and the three
 * split stages (prepare / dub-worker / merge) interpret the same value the
 * same way.
 */

import path from 'node:path';
import * as rask from './rask.mjs';

const env = process.env;

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const flag = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const onFailRaw = String(env.ON_FAIL || '').trim().toLowerCase();
// ON_FAIL wins; ALLOW_PARTIAL is kept only so an old local invocation that
// relied on "pad the hole with silence" still behaves that way.
const ON_FAIL = ['original', 'silence', 'error'].includes(onFailRaw)
  ? onFailRaw
  : (flag(env.ALLOW_PARTIAL, false) ? 'silence' : 'original');

const shardRaw = env.SHARD === undefined ? '' : String(env.SHARD).trim();

/**
 * Default tone prompt for every project the runner creates.
 *
 * Rask reads the project prompt during the first translation pass, so it is sent
 * with the create call. The wording below is deliberately blunt: models drift
 * back to written Persian ("باید کلیک کنید") unless the colloquial register and
 * the second-person singular are spelled out with examples.
 *
 * Written entirely in Persian on purpose (a half-Persian/half-English prompt
 * diluted the Persian-specific rules). Diacritics are now BOUNDED: the old
 * "write every word fully vocalized" rule made the model emit confident but
 * wrong kasra/fatha, and a wrong vowel is worse for TTS than no vowel at all.
 * Pauses are handled by punctuation and short clauses, which is the only thing
 * the translation stage can actually control.
 */
export const DEFAULT_TRANSLATION_PROMPT = [
  'تو مترجم حرفه‌ای دوبله هستی. متن را به فارسی محاوره‌ای و طبیعی ترجمه کن؛',
  'لحن دوستانه و روزمره، مثل حرف زدن یک آدم واقعی — نه کتابی، نه خبری، نه رسمی.',
  'فقط متن ترجمه را بده؛ مقدمه، توضیح و گلچین ننویس. معنا را مو‌به‌مو حفظ کن، چیزی اضافه یا حذف نکن.',
  'دوم‌شخص مفرد: «تو». «شما / می‌باشد / می‌گردد / خواهم / آن را» ممنوع.',
  'هر جمله حداکثر ۱۰ کلمه و یک‌نفسی باشد؛ جمله‌های بلند را بشکن.',
  'مکث را فقط با نشانه‌گذاری بساز و هرگز حذفش نکن:',
  '«،» مکث کوتاه، «؛» مکث متوسط، «.» مکث کامل، «…» مکث کشیده یا تردید.',
  'جمله‌ها را به هم نچسبان و علائم را قربانی کوتاه‌کردن نکن.',
  'اعداد و درصد و ساعت را با حروف بنویس: ۳ ← «سه»، ۲۵٪ ← «بیست‌وپنج درصد»، ۱۰:۳۰ ← «ده و نیم».',
  'هیچ حرف لاتینی نگذار. اصطلاح فنی و نام را با حروف فارسی و آوانگاری طبیعی بنویس:',
  'code ← «کد»، API ← «اِی‌پی‌آی»، online ← «آنلاین»، video ← «ویدیو».',
  'اعراب را فقط جایی بگذار که بدون آن خواندن کلمه اشتباه می‌شود',
  '(کِرم/کَرَم، مُلک/مِلک/مَلَک، سَبک/سبُک). هرگز همهٔ کلمه‌ها را اعراب‌گذاری نکن؛ اعراب غلط بدتر از بی‌اعراب است.',
  'کلمه را همان‌طور که تلفظ می‌شود بنویس: «می‌روم» ← «میرم»، «برای» ← «واسه»، «آن را» ← «اون رو».',
  'اگر جا کم آمد کلمهٔ کوتاه‌تر انتخاب کن؛ ترتیب جمله را به‌هم نزن و معنا را قربانی نکن.',
].join('\n');

const promptRaw = String(env.TRANSLATION_PROMPT ?? '').trim();
const promptOff = ['off', 'none', '0', 'false', 'no'].includes(promptRaw.toLowerCase());

export const cfg = {
  input: env.INPUT_URL || env.INPUT || '',
  target: rask.resolveLanguage(env.TARGET_LANG || 'Persian'),
  workDir: path.resolve(env.WORK_DIR || 'work'),

  // Rask bills one minute per project and refuses anything longer.
  chunkSeconds: clamp(num(env.CHUNK_SECONDS, 55), 20, 59),
  hardCap: clamp(num(env.HARD_CAP_SECONDS, 58), 20, 60),

  // Projects running at the same time on a single account.
  parallel: clamp(num(env.PARALLEL_CHUNKS, 3), 1, 5),
  // Accounts a single worker may open (0 = derive from the queue length).
  maxAccounts: Math.max(0, num(env.MAX_ACCOUNTS, 0)),
  chunkTries: clamp(num(env.CHUNK_TRIES, 3), 1, 5),
  // Extra end-of-run passes over failed chunks, each on a fresh account.
  retryRounds: clamp(num(env.RETRY_ROUNDS, 2), 0, 4),

  otpWait: clamp(num(env.OTP_WAIT_SECONDS, 180), 30, 300),
  maxChunks: Math.max(0, num(env.MAX_CHUNKS, 0)),

  onFail: ON_FAIL,
  minSpeech: Math.max(0, num(env.MIN_SPEECH_SECONDS, 0.4)),
  skipSilent: flag(env.SKIP_SILENT, true),
  whisperModel: env.WHISPER_MODEL || 'base',

  outputName: (env.OUTPUT_NAME || '').trim(),

  // Source download. Plain http(s) links still go through curl; a YouTube link
  // is resolved by yt-dlp through the egress selected by PROXY_ENABLED
  // (Firefox VPN or Oxylabs). There is deliberately no cookie path: see
  // proxy.mjs and youtube.mjs.
  ytdlp: (env.YTDLP || 'yt-dlp').trim(),
  ytFormat: (env.YT_FORMAT || 'bv*+ba/b').trim(),
  ytdlpArgs: (env.YTDLP_ARGS || '').trim(),

  // Rask's translation prompt (tone/style). It must be set when the project is
  // created: the pipeline reads it during the first translation pass, and Free
  // projects cannot be re-dubbed afterwards. The colloquial default applies to
  // every run unless TRANSLATION_PROMPT overrides it (or is set to "off").
  translationPrompt: promptOff ? null : (promptRaw || DEFAULT_TRANSLATION_PROMPT),

  // Parallel runners: the prepare stage splits the timeline into N shards and
  // the workflow runs one dub job per shard.
  runners: clamp(num(env.PARALLEL_RUNNERS, 1), 1, 16),
  shard: shardRaw === '' ? null : Math.max(0, num(shardRaw, 0)),
};

if (cfg.hardCap < cfg.chunkSeconds) cfg.hardCap = cfg.chunkSeconds;

cfg.outDir = path.join(cfg.workDir, 'out');
cfg.chunksDir = path.join(cfg.workDir, 'chunks');
cfg.dubDir = path.join(cfg.workDir, 'dub');
cfg.reportsDir = path.join(cfg.workDir, 'reports');
cfg.raskDir = path.join(cfg.workDir, 'rask');
cfg.stateFile = path.join(cfg.workDir, cfg.shard === null ? 'state.json' : `state-${cfg.shard}.json`);
cfg.trackFile = path.join(cfg.workDir, 'dubbed-full.mp3');
