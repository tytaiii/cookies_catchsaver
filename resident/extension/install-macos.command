#!/bin/bash
# 常驻站 Cookie 助手 - 安装助手（macOS：双击这个 .command 文件）

set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/ResidentCookieHelper"

echo ""
echo "  =========================================="
echo "    常驻站 Cookie 助手 - 安装助手"
echo "  =========================================="
echo ""

if [ ! -f "$SRC/manifest.json" ]; then
  echo "  [错误] 这个脚本必须和 manifest.json 放在同一个文件夹里。"
  echo "         请先解压 zip，再双击这个 .command。"
  echo ""
  read -r -p "  按回车退出..." _
  exit 1
fi

mkdir -p "$DEST"
cp -f "$SRC"/manifest.json "$SRC"/popup.html "$SRC"/popup.js "$SRC"/options.html "$SRC"/options.js "$SRC"/README.md "$DEST/"
echo "  文件已放到："
echo "    $DEST"
echo ""

printf '%s' "$DEST" | pbcopy 2>/dev/null || true

echo "  接下来只剩两次点击："
echo ""
echo "    1. 在刚打开的扩展页右上角，打开「开发者模式」"
echo "    2. 点「加载已解压的扩展程序」，选择这个路径（已复制到剪贴板）"
echo ""
echo "       $DEST"
echo ""
echo "  装好后点工具栏的 🍪 图标，填服务地址和令牌。"
echo ""

open -a "Google Chrome" "chrome://extensions" 2>/dev/null \
  || open -a "Microsoft Edge" "edge://extensions" 2>/dev/null \
  || open "https://support.google.com/chrome_webstore/answer/2664769"

echo "  如果浏览器没自动打开，手动在地址栏输入：chrome://extensions"
echo ""
read -r -p "  按回车关闭..." _
