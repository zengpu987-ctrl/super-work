#!/bin/bash
# 构建 Super Work.app（Swift + WKWebView 原生壳，零 npm 依赖）。
#
# 用法：
#   bash apps/mac/build.sh            # 只构建 → apps/mac/build/Super Work.app
#   bash apps/mac/build.sh --open     # 构建后立即启动
#
# 幂等：每次都会重新生成 .app；期间不会修改仓库里其它文件。
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MAC_DIR/../.." && pwd)"
BUILD_DIR="$MAC_DIR/build"
APP="$BUILD_DIR/Super Work.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

echo "[mac] 项目目录：$ROOT"
echo "[mac] 构建目录：$BUILD_DIR"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[mac] 错误：没有找到 swiftc。请先安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# 1) 编译原生壳
echo "[mac] 编译 Swift…"
swiftc \
  -O \
  -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -framework Cocoa \
  -framework WebKit \
  -o "$MACOS_DIR/SuperWork" \
  "$MAC_DIR"/src/*.swift

# 2) Info.plist 与图标
cp "$MAC_DIR/resources/Info.plist" "$CONTENTS/Info.plist"
if [ -f "$MAC_DIR/resources/AppIcon.icns" ]; then
  cp "$MAC_DIR/resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
else
  echo "[mac] 警告：缺少 resources/AppIcon.icns，尝试重新生成（需要 python3 + Pillow）"
  if python3 "$MAC_DIR/resources/make-icon.py" >/dev/null 2>&1; then
    cp "$MAC_DIR/resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
  else
    echo "[mac] 图标生成失败，使用系统默认图标。"
  fi
fi

# 3) 构建时兜底信息（运行期优先级低于环境变量与 config.json）
printf '%s\n' "$ROOT" > "$RESOURCES_DIR/repo-root.txt"

NODE_BIN="$(command -v node 2>/dev/null || true)"
PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
if [ -n "$NODE_BIN" ]; then
  printf '%s\n' "$(readlink -f "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")" > "$RESOURCES_DIR/node-path.txt"
fi

PATH_HINTS=()
[ -n "$NODE_BIN" ] && PATH_HINTS+=("$(dirname "$(readlink -f "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")")")
[ -n "$PNPM_BIN" ] && PATH_HINTS+=("$(dirname "$PNPM_BIN")")
if [ ${#PATH_HINTS[@]} -gt 0 ]; then
  printf '%s\n' "${PATH_HINTS[@]}" | awk 'NF && !seen[$0]++' | paste -sd: - > "$RESOURCES_DIR/env-path.txt"
fi

# 4) ad-hoc 签名（本机运行足够，不做公证）
echo "[mac] ad-hoc 签名…"
codesign --force --deep --sign - "$APP" >/dev/null

# 5) 自检
plutil -lint "$CONTENTS/Info.plist" >/dev/null
codesign --verify --deep --strict "$APP"
echo "[mac] 校验通过："
echo "       $APP"
echo "       $(du -sh "$APP" | awk '{print $1}')"
echo "       node 兜底：${NODE_BIN:-未找到}"

if [ "${1:-}" = "--open" ]; then
  echo "[mac] 启动应用…"
  open "$APP"
fi
