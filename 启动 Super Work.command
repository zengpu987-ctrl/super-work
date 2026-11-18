#!/bin/bash
# 双击这个文件即可启动 Super Work（macOS）。关闭终端窗口 = 停止服务。
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装 Node 22 或更高版本（https://nodejs.org）。"
  read -r -p "按回车退出…"
  exit 1
fi
node scripts/start.mjs
read -r -p "服务已停止，按回车关闭窗口…"
