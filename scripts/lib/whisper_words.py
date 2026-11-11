"""Transcribe an audio file with Whisper and dump word-level timestamps as JSON.

Usage: python whisper_words.py <model> <audio> <out.json> [language]
Language may be a display name ("Persian (Farsi)") or an ISO code; "Auto" = detect.
"""

import json
import re
import sys

import whisper
from whisper.tokenizer import LANGUAGES, TO_LANGUAGE_CODE


def normalise_language(raw: str):
    value = (raw or "").strip().lower()
    if not value or value in ("auto", "auto detect", "automatic"):
        return None
    value = re.sub(r"\s*\([^)]*\)$", "", value)  # "persian (farsi)" -> "persian"
    aliases = {
        "farsi": "persian",
        "mandarin": "chinese",
        "mandarin chinese": "chinese",
        "cantonese": "chinese",
        "brazilian portuguese": "portuguese",
    }
    value = aliases.get(value, value)
    if value in LANGUAGES:
        return value
    if value in TO_LANGUAGE_CODE:
        return TO_LANGUAGE_CODE[value]
    return None


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: whisper_words.py <model> <audio> <out.json> [language]", file=sys.stderr)
        return 2

    model_name, audio_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    language = normalise_language(sys.argv[4] if len(sys.argv) > 4 else "Auto")

    model = whisper.load_model(model_name)
    kwargs = dict(word_timestamps=True, verbose=False, condition_on_previous_text=False)
    if language:
        kwargs["language"] = language
    result = model.transcribe(audio_path, **kwargs)

    words = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []) or []:
            if word.get("start") is None or word.get("end") is None:
                continue
            words.append(
                {
                    "start": round(float(word["start"]), 3),
                    "end": round(float(word["end"]), 3),
                    "word": str(word.get("word", "")).strip(),
                }
            )

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"language": result.get("language"), "words": words}, handle, ensure_ascii=False)

    print(f"words={len(words)} language={result.get('language')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
