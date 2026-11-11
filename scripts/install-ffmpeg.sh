#!/usr/bin/env bash
# Install ffmpeg only if it is not already there.
#
# Why this exists: `ubuntu-latest` moved to ubuntu-26.04 ("resolute"), where
#   - ffmpeg is not preinstalled, and
#   - azure.archive.ubuntu.com has no resolute repos, so `apt-get update`
#     just prints "Ign:..." forever and the step dies on its timeout.
# So: check the PATH first, then grab a static build (no sudo, no apt),
# and only fall back to apt as a last resort.
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

if have ffmpeg && have ffprobe; then
  echo "ffmpeg already installed: $(ffmpeg -version | head -n 1)"
  ffprobe -version | head -n 1
  exit 0
fi

echo "ffmpeg not found on PATH — installing a static build"

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)"; exit 1 ;;
esac

DEST="${HOME}/.local/ffmpeg"
mkdir -p "$DEST"

try_static() {
  local url="$1" file="$2"
  echo "→ $url"
  if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 420 "$url" -o "/tmp/${file}"; then
    return 1
  fi
  local work
  work="$(mktemp -d)"
  if ! tar -xf "/tmp/${file}" -C "$work" 2>/dev/null; then
    echo "extract failed: ${file}"
    return 1
  fi
  local dir
  dir="$(find "$work" -type f -name ffmpeg -printf '%h\n' | head -n 1)"
  if [ -z "$dir" ] || [ ! -f "$dir/ffprobe" ]; then
    echo "archive did not contain ffmpeg+ffprobe"
    return 1
  fi
  install -m 0755 "$dir/ffmpeg" "$dir/ffprobe" "$DEST/"
  rm -rf "$work" "/tmp/${file}"
  return 0
}

if ! try_static "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" "ffmpeg-jsb.tar.xz"; then
  try_static "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" "ffmpeg-btbn.tar.xz" || true
fi

if [ -x "$DEST/ffmpeg" ] && [ -x "$DEST/ffprobe" ]; then
  export PATH="$DEST:$PATH"
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >> "$GITHUB_PATH"; fi
  echo "installed static build: $(ffmpeg -version | head -n 1)"
  ffprobe -version | head -n 1
  exit 0
fi

echo "static builds failed — falling back to apt"
sudo systemctl stop unattended-upgrades 2>/dev/null || true
sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 install -y --no-install-recommends ffmpeg
ffmpeg -version | head -n 1
