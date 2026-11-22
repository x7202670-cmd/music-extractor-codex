#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$HOME/.gemini/config/plugins/music-extractor}"
FFMPEG_PATH="${MUSIC_EXTRACTOR_FFMPEG:-}"

if [[ -f "$SCRIPT_DIR/plugins/music-extractor/mcp-server.cjs" ]]; then
  PLUGIN_SRC="$SCRIPT_DIR/plugins/music-extractor"
elif [[ -f "$SCRIPT_DIR/music-extractor/mcp-server.cjs" ]]; then
  PLUGIN_SRC="$SCRIPT_DIR/music-extractor"
else
  echo "未找到 plugins/music-extractor/mcp-server.cjs，请在仓库根目录或安装包根目录运行本脚本。" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

for file in mcp-server.cjs tools.cjs sources.cjs files.cjs; do
  cp -f "$PLUGIN_SRC/$file" "$TARGET_ABS/$file"
done

if [[ -f "$PLUGIN_SRC/backend.cjs" ]]; then
  cp -f "$PLUGIN_SRC/backend.cjs" "$TARGET_ABS/backend.cjs"
elif [[ -f "$SCRIPT_DIR/../server.js" ]]; then
  cp -f "$SCRIPT_DIR/../server.js" "$TARGET_ABS/backend.cjs"
else
  echo "未找到 backend.cjs 或 server.js。" >&2
  exit 1
fi

rm -rf "$TARGET_ABS/skills"
if [[ -d "$PLUGIN_SRC/skills" ]]; then
  cp -R "$PLUGIN_SRC/skills" "$TARGET_ABS/skills"
fi

cat > "$TARGET_ABS/plugin.json" <<'EOF'
{
  "name": "music-extractor",
  "displayName": "音乐提取器",
  "version": "1.2.0",
  "description": "搜索网易云音乐，解析B站和抖音视频/图集（含实况），并在本机下载和提取音频（MP3/FLAC/WAV）。",
  "repository": "https://github.com/x7202670-cmd/music-extractor-codex",
  "suggestedPrompts": [
    "在网易云搜索周杰伦的《稻香》并下载",
    "解析并下载这个 B 站或抖音视频/图集",
    "把本地视频的音轨提取成 MP3 或 FLAC"
  ]
}
EOF

TARGET_ABS="$TARGET_ABS" FFMPEG_PATH="$FFMPEG_PATH" node -e '
const fs = require("node:fs");
const path = require("node:path");
const target = process.env.TARGET_ABS;
const ffmpeg = process.env.FFMPEG_PATH;
const entry = { command: "node", args: [path.join(target, "mcp-server.cjs")] };
if (ffmpeg) entry.env = { MUSIC_EXTRACTOR_FFMPEG: ffmpeg };
fs.writeFileSync(
  path.join(target, "mcp_config.json"),
  JSON.stringify({ mcpServers: { "music-extractor": entry } }, null, 2) + "\n"
);
'

echo "已将「音乐提取器」安装到 Antigravity 插件目录：$TARGET_ABS"
if ! command -v node >/dev/null 2>&1; then
  echo "警告：未在 PATH 中检测到 node，请先安装 Node.js 24.5 或更新版本。" >&2
fi
if ! command -v ffmpeg >/dev/null 2>&1 && [[ -z "$FFMPEG_PATH" ]]; then
  echo "提示：未检测到 ffmpeg，若需音频转码或 B 站 DASH 合成，请先安装 ffmpeg。" >&2
fi
