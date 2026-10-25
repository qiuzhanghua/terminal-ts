#!/usr/bin/env bash
#
# build-appimage.sh —— 离线可用的 AppImage 打包入口
#
# 背景：`npm run tauri build` 默认只出 deb + rpm（见 tauri.conf.json 的
# bundle.targets）。AppImage 走 linuxdeploy + linuxdeploy-plugin-appimage，
# 后者**每次构建**都会从 GitHub 现下载 type2-runtime（约 944 KB，无缓存）；
# GitHub 不可达时就失败，而 Tauri 只会打印一句泛化的
# `failed to run linuxdeploy`，看不出真实原因。
#
# 本脚本把 runtime 预存到 ${XDG_CACHE_HOME:-~/.cache}/tauri/runtime-x86_64，
# 再用插件支持的 LDAI_RUNTIME_FILE 传给 linuxdeploy —— 只有第一次需要联网。
#
#   bash scripts/build-appimage.sh              # 等价于 npm run build:appimage
#   bash scripts/build-appimage.sh --no-bundle  # 额外参数原样传给 tauri build
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
RUNTIME="$CACHE_DIR/runtime-x86_64"
URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64"
MIN_SIZE=900000  # 实际 944632 字节，留点余量

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }

mkdir -p "$CACHE_DIR"

# 缓存可用性：大小够 + ELF 魔数，防止把半截下载或错误页当成 runtime。
runtime_ok() {
  [[ -f "$RUNTIME" ]] || return 1
  local size
  size=$(stat -c %s "$RUNTIME" 2>/dev/null || echo 0)
  (( size >= MIN_SIZE )) || return 1
  [[ "$(head -c 4 "$RUNTIME" | od -An -tx1 | tr -d ' \n')" == "7f454c46" ]]
}

if runtime_ok; then
  log "使用缓存的 runtime：$RUNTIME"
else
  log "缓存缺失或无效，下载 runtime：$URL"
  tmp="$RUNTIME.part"
  rm -f "$tmp"
  # GitHub 在这台机器上时通时断，重试几次；失败要让用户看到明确提示。
  if ! curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
      --connect-timeout 20 --max-time 300 -o "$tmp" "$URL"; then
    rm -f "$tmp"
    warn "下载 runtime 失败。请检查到 github.com 的连通性后重试，"
    warn "或手动把 runtime 放到 $RUNTIME（大小约 944632 字节）。"
    exit 1
  fi
  mv -f "$tmp" "$RUNTIME"
  runtime_ok || { warn "$RUNTIME 校验不通过（期望 ELF 且 ≥ $MIN_SIZE 字节）"; exit 1; }
  log "已缓存 runtime：$RUNTIME"
fi

# linuxdeploy 本体由 Tauri 自己管理；缺失时它会尝试联网下载，这里只做提醒。
if [[ ! -x "$CACHE_DIR/linuxdeploy-x86_64.AppImage" ]]; then
  warn "未找到 $CACHE_DIR/linuxdeploy-x86_64.AppImage，Tauri 会尝试联网下载（同样受 GitHub 连通性影响）"
fi

export LDAI_RUNTIME_FILE="$RUNTIME"
log "LDAI_RUNTIME_FILE=$LDAI_RUNTIME_FILE"

cd "$ROOT"
exec npm run tauri build -- --bundles appimage "$@"
