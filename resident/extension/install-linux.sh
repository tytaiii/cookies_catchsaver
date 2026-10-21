#!/usr/bin/env bash
# 常驻站 Cookie 助手 - 安装助手（Linux）
# 用法：右键 → 以程序运行；或终端里执行 bash install-linux.sh

set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/ResidentCookieHelper"

echo
echo "  =========================================="
echo "    常驻站 Cookie 助手 - 安装助手"
echo "  =========================================="
echo

if [ ! -f "$SRC/manifest.json" ]; then
  echo "  [错误] 这个脚本必须和 manifest.json 放在同一个文件夹里。"
  echo "         请先解压 zip。"
  exit 1
fi

mkdir -p "$DEST"
cp -f "$SRC"/manifest.json "$SRC"/popup.html "$SRC"/popup.js "$SRC"/options.html "$SRC"/options.js "$SRC"/README.md "$DEST/"

echo "  文件已放到："
echo "    $DEST"
echo ""

# 路径尽量放进剪贴板，省得在文件选择框里翻
COPIED=0
if command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$DEST" | wl-copy 2>/dev/null && COPIED=1
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$DEST" | xclip -selection clipboard 2>/dev/null && COPIED=1
elif command -v xsel >/dev/null 2>&1; then
  printf '%s' "$DEST" | xsel --clipboard --input 2>/dev/null && COPIED=1
fi
[ "$COPIED" = "1" ] && echo "  路径已复制到剪贴板。" || echo "  （没装剪贴板工具，手动复制下面的路径）"
echo ""

cat <<EOF
  接下来只剩两次点击：

    1. 在刚打开的扩展页右上角，打开「开发者模式」
    2. 点「加载已解压的扩展程序」，选择这个路径

       $DEST

  装好后点工具栏的 🍪 图标，点「自动连接」。

EOF

for B in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$B" >/dev/null 2>&1; then
    echo "  正在打开 ${B}..."
    ("$B" "chrome://extensions" >/dev/null 2>&1 &)
    exit 0
  fi
done

echo "  没找到 Chrome / Chromium / Edge。请手动打开浏览器，地址栏输入：chrome://extensions"
