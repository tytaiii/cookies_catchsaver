# Resident Cookie 助手

Chromium 扩展：读取当前网页可发送的 Cookie（包括 HttpOnly），写入你自己的 Resident 服务并立即检测登录态。也可以管理站点、查看状态、编辑凭据或只复制 Cookie。

## 安装

在 Chrome、Edge 或 Brave 的扩展页启用开发者模式，选择“加载已解压的扩展程序”，指向本目录。`install-windows.bat`、`install-macos.command`、`install-linux.sh` 可帮你把文件复制到固定目录并打开扩展页；最后的加载操作仍需手动完成。

## 首次连接

1. 部署 Resident，并通过 HTTPS 将其挂到 `https://你的域名/resident/`。
2. 在扩展“服务设置”输入 `https://你的域名/resident`，点击保存。扩展没有预设服务器地址。
3. 从 `~/resident/data/token.txt` 取得令牌后手动输入；或者先在同一浏览器打开服务页面并登录，再点“自动连接”。自动连接只读取与你填写的服务地址同源的 `/resident/` 页面。

远程服务必须使用 HTTPS。本机 `localhost`、`127.0.0.1` 可用 HTTP。若服务设置了 `SERVE_WEB=0`，请手动输入令牌。

## 日常使用

打开已登录的目标网站，点击工具栏的 Cookie 助手图标。扩展会显示当前页面 Cookie 数量，自动选中域名匹配的常驻站；确认后点“写入并检测”。若没有对应站点，可以直接新建。管理面板在扩展选项页。

## 权限和数据

| 权限 | 用途 |
| --- | --- |
| `cookies` | 读取当前页面可发送的 Cookie，包括 HttpOnly |
| `activeTab` | 识别当前页面 |
| `scripting` | 在已登录的 Resident 页面读取本地保存的令牌 |
| `storage` | 在本机保存服务地址和令牌 |
| `<all_urls>` | 适配用户自行部署的服务和任意目标网站 |

Cookie 只在你点击“写入并检测”或“新建并写入”后发送至所配置的 Resident 服务；“只复制”会把 Cookie 写入剪贴板。令牌保存在 `chrome.storage.local`。请只连接可信服务，不要在共享电脑上保存敏感登录态。
