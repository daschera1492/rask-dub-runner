# dub-sync

صدای دوبله‌شده را **دقیقاً** روی تایملاین ویدیوی اصلی می‌نشاند، بعد دو خروجی جدا می‌سازد و در GitHub Release می‌گذارد.

- `out/<name>.mp3` — فقط صدا، هم‌طول دقیق ویدیو
- `out/<name>.mp4` — ویدیوی اصلی با `-c:v copy` (بدون ریکود، بدون افت کیفیت) + صدای جدید

نه دوبله می‌کند، نه اکانت می‌سازد، نه پروکسی می‌خواهد. فقط سینک + خروجی + انتشار.

## تضمین‌ها (اندازه‌گیری‌شده، نه ادعا)

`npm run selftest` روی مدیای ساختگی سه حالت را می‌سنجد: صدای کوتاه‌تر از ویدیو، بلندتر، و با آفست.

```
[selftest] video 370 frames @ 12333ms → 592000 samples
[selftest] short   mp3=592000 mp4audio=592000 expected=592000 video=370/370 → OK
[selftest] long    mp3=592000 mp4audio=592000 expected=592000 video=370/370 → OK
[selftest] offset  mp3=592000 mp4audio=592000 expected=592000 video=370/370 → OK
[selftest] all guarantees hold
```

| چیز | وضعیت |
| --- | --- |
| تعداد سمپل صدا = تعداد سمپل ویدیو | ✅ دقیق (۰ سمپل اختلاف) |
| شروع/پایان هر تکه روی تایم اصلی | ✅ sample-accurate (با `SEGMENTS_JSON`) |
| استریم تصویر mp4 | ✅ همان فریم‌های اصلی، `-c:v copy` |
| آفست دلخواه | ✅ `AUDIO_OFFSET_MS` با دقت سمپل |
| mp3 | ✅ drift صفر (LAME gapless tag نوشته می‌شود) |

### پیامدهای این تضمین‌ها

- اگر صدای دوبله از ویدیو **کوتاه‌تر** باشد → آخرش سکوت پر می‌شود.
- اگر **بلندتر** باشد → از انتهای ویدیو بریده می‌شود.
- در حالت تکه‌ای، تکه‌ای که از بازهٔ خودش بلندتر است با `atempo` فشرده می‌شود. بالای **۱.۳۵×** سرعت شنیده می‌شود و اسکریپت هشدار می‌دهد.

## نصب

ffmpeg لازم است. اسکریپت به ترتیب این‌ها را امتحان می‌کند:
`FFMPEG_PATH` → `tools/ffmpeg/bin/ffmpeg.exe` → `PATH`.

```powershell
# ویندوز، بدون دسترسی ادمین
npm run selftest
```

## اجرا (لوکال)

```powershell
$env:INPUT_VIDEO   = "C:\path\video.mp4"
$env:INPUT_AUDIO   = "C:\path\dubbed.mp3"     # یا یک لینک https
$env:OUTPUT_NAME   = "my-video-fa"
$env:AUDIO_OFFSET_MS = "0"                    # مثبت = صدا دیرتر شروع شود
node scripts/sync.mjs
```

### حالت تکه‌ای (دقیق‌ترین)

اگر صدا را به‌صورت تکه‌های جدا داری، هر تکه را با بازهٔ خودش بده:

```json
[
  { "start": 0.0,  "end": 12.4, "file": "seg/000.mp3" },
  { "start": 13.1, "end": 25.9, "file": "https://.../001.mp3" }
]
```

```powershell
$env:SEGMENTS_JSON = "C:\path\segments.json"
node scripts/sync.mjs
```

هر تکه داخل بازهٔ خودش فیت می‌شود (کم‌بودن با سکوت، زیادی با `atempo`)، بین بازه‌ها سکوت، و شروع هر تکه دقیقاً روی `start` می‌نشیند.

## تفکیک گفتار از سکوت — `plan.mjs`

```powershell
$env:INPUT_VIDEO = "C:\path\video.mp4"
$env:OUT_DIR     = "out"
node scripts/plan.mjs
```

خروجی: `out/<name>.plan.json` + `out/chunks/NNN.mp3`

قواعد:

- هر تکه‌ای که **هر مقدار** گفتار دارد نگه داشته می‌شود — حتی یک کلمه.
- تکهٔ بدون گفتار با `"speech": false` ثبت می‌شود و **هیچ فایلی برایش ساخته نمی‌شود**.
- مرز تکه‌ها داخل سکوت می‌افتد، نه وسط کلمه (`MERGE_GAP`).
- مکث‌های کوتاه‌تر از `JOIN_GAP` (پیش‌فرض ۲ ثانیه) تکه را نمی‌شکنند. چون هر پروژهٔ دوبله **یک دقیقهٔ کامل** حساب می‌شود، شکستن روی هر جملهٔ ۲ ثانیه‌ای یعنی یک دقیقه سهمیه برای هر جمله. با `JOIN_GAP=2` روی یک ویدیوی ۳۱ دقیقه‌ای: ۱۷۴ بازهٔ گفتار → ۵۳ تکهٔ ارسالی (به‌جای ۱۸۲).
- کل تایم‌لاین پیوسته پوشش داده می‌شود: از `0` تا انتهای ویدیو.

```json
{
  "duration": 20.0,
  "summary": { "segments": 7, "speech": 3, "silence": 4, "billedMinutes": 3 },
  "segments": [
    { "index": 0, "name": "000", "start": 0.0,  "end": 2.02,   "duration": 2.02,  "speech": false, "file": null },
    { "index": 1, "name": "001", "start": 2.02, "end": 6.014,  "duration": 3.994, "speech": true,  "file": "out/chunks/001.mp3" }
  ]
}
```

`plan.json` را می‌توان مستقیم به `sync.mjs` داد (هم به‌صورت `{segments:[…]}` و هم آرایهٔ خام). برای هر `speech:false`، `sync` خودش سکوت هم‌طول می‌گذارد.

اگر برای تکه‌ای فایل دوبله نرسیده باشد و بخواهی بقیه منتشر شود: `ALLOW_MISSING=1` (در ورک‌فلو: `allow_missing`).

**تست‌شده** روی ویدیوی 20 ثانیه‌ای با سه بازهٔ گفتار: 3 تکهٔ بادیالوگ + 4 سکوت، پخش دقیق روی 2.02-6.01، 9.01-12.0، 15.0-19.0 و سکوت در بقیه؛ خروجی 960000 سمپل = دقیقاً طول ویدیو.

## انتشار در Release

```powershell
$env:RELEASE      = "1"
$env:GH_REPO      = "owner/repo"
$env:GH_TOKEN     = $env:GITHUB_TOKEN   # یا gh auth login
node scripts/sync.mjs
```

تگ به‌صورت `sync-20261111-143000` ساخته می‌شود و `mp3` + `mp4` + `report.json` به‌عنوان asset آپلود می‌شوند؛ لینک دانلود مستقیم از صفحهٔ Release.

## اجرا در GitHub Actions

- `.github/workflows/sync.yml` — دستی (`Run workflow`): `video_url`, `audio_url` (یا `segments_json`)، `offset_ms`، `publish`.
- `.github/workflows/cleanup.yml` — هر روز ۰۳:۱۷ UTC ریلیزهای قدیمی‌تر از `RETENTION_DAYS` (پیش‌فرض ۳۰) را حذف می‌کند.

هیچ PAT لازم نیست: هر دو ورک‌فلو از `secrets.GITHUB_TOKEN` با `permissions: contents: write` استفاده می‌کنند. کافی است در تنظیمات مخزن، Actions → General → Workflow permissions روی **Read and write** باشد.

### پاک‌سازی

```powershell
$env:GH_TOKEN = "..."; $env:GH_REPO = "owner/repo"
$env:RETENTION_DAYS = "30"
$env:DRY_RUN = "1"   # اول خشک اجرا کن
node scripts/cleanup.mjs
```

- تگ‌هایی که با `keep` شروع شوند هرگز حذف نمی‌شوند.
- `KEEP_LATEST=1` همیشه N ریلیز آخر را نگه می‌دارد.

## متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `INPUT_VIDEO` | — | مسیر یا لینک ویدیوی اصلی (اجباری) |
| `INPUT_AUDIO` | — | مسیر یا لینک صدای دوبله‌شده |
| `SEGMENTS_JSON` | — | مسیر یا خودِ JSON تکه‌ها (جایگزین `INPUT_AUDIO`) |
| `AUDIO_OFFSET_MS` | `0` | جابه‌جایی کل صدا (ms) |
| `OUTPUT_NAME` | `<video>-synced` | نام فایل‌های خروجی |
| `AUDIO_BITRATE` | `192k` | بیت‌ریت mp3 و AAC |
| `WORK_DIR` / `OUT_DIR` | `work` / `out` | پوشهٔ موقت و خروجی |
| `RELEASE` | `false` | ساخت Release |
| `RELEASE_TAG` / `RELEASE_TITLE` | خودکار | سفارشی‌سازی تگ و عنوان |
| `GH_REPO` | `GITHUB_REPOSITORY` | `owner/repo` |
| `RETENTION_DAYS` | `30` | فقط برای cleanup |

## محدودیت‌ها

- حجم هر asset در GitHub Release حداکثر **۲ گیگابایت** است؛ ویدیوی بزرگ‌تر را باید تکه کرد.
- ویدیوهایی با کدک غیر mp4-friendly (`vp8`, `mpeg2`, …) به‌جای copy با `x264 -crf 18` ریکود می‌شوند (در لاگ می‌بینی).
- سینک، صدای **موجود** را فیکس می‌کند؛ اگر خودِ صدای دوبله از نظر محتوا با تصویر هم‌زمان نباشد، این ابزار آن را درست نمی‌کند.
- تایم‌استمپ‌ها را باید از قبل داشته باشی (`start`/`end` هر تکه). استخراج تایم‌استمپ کار این پروژه نیست.

## امنیت

توکن گیت‌هاب را در چت یا فایل نگذار. `GITHUB_TOKEN` داخل Actions برای ساخت و حذف ریلیز کافی است. اگر PAT ساختی، حداقل دسترسی `contents: write` روی همان یک مخزن و با انقضای کوتاه.
