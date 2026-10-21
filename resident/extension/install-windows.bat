@echo off
chcp 65001 >nul
setlocal

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\ResidentCookieHelper"

echo.
echo  ==========================================
echo    常驻站 Cookie 助手 - 安装助手
echo  ==========================================
echo.

if not exist "%SRC%manifest.json" (
  echo  [错误] 这个脚本必须和 manifest.json 放在同一个文件夹里。
  echo         请先把 zip 解压，再右键这个 .bat 运行。
  echo.
  pause
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
copy /Y "%SRC%manifest.json"  "%DEST%\" >nul
copy /Y "%SRC%popup.html"     "%DEST%\" >nul
copy /Y "%SRC%popup.js"       "%DEST%\" >nul
copy /Y "%SRC%options.html"   "%DEST%\" >nul
copy /Y "%SRC%options.js"     "%DEST%\" >nul
copy /Y "%SRC%README.md"      "%DEST%\" >nul

echo  文件已放到：
echo    %DEST%
echo.
echo  接下来只剩两次点击：
echo.
echo    1. 在刚打开的扩展页右上角，打开「开发者模式」
echo    2. 点「加载已解压的扩展程序」，选择下面这个路径
echo.
echo       %DEST%
echo.
echo  （路径已复制到剪贴板，在选文件夹的窗口里按 Ctrl+V 回车即可）
echo.
echo  装好后点工具栏的 🍪 图标，填服务地址和令牌。
echo.

echo %DEST%| clip >nul 2>&1
start "" chrome "chrome://extensions" >nul 2>&1
if errorlevel 1 start "" msedge "edge://extensions" >nul 2>&1

echo  如果浏览器没自动打开，手动在地址栏输入：chrome://extensions
echo.
pause
