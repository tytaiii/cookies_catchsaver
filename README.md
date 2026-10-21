# Cookie Catchsaver

自托管的网站登录态保活与文件空间。Resident 保存站点 Cookie 或请求头，定期检查会话，并提供带凭据的读取接口；配套 Chromium 扩展可从当前网页读取 Cookie（包括 HttpOnly）并写入服务。Space 把指定目录变成一个可浏览、可下载的网页。

> Self-hosted session keeper and file space, with a Chromium cookie helper. The two services use Node.js built-ins only; no npm install is required.

## 项目组成

| 目录 | 用途 |
| --- | --- |
| `resident/server.js` | 登录态加密存储、定时检测和带凭据的 HTTP 请求 API |
| `resident/public/` | 可选的网页管理界面 |
| `resident/extension/` | Chromium 扩展：抓取当前页面 Cookie、管理站点 |
| `space/server.js` | 目录列表、文件下载和删除 |
| `deploy/` | Linux 用户级 systemd 与 nginx 配置示例 |

两个服务默认只监听 `127.0.0.1`，分别使用 8901 和 8902 端口。公开访问时建议用 HTTPS 反代到 `/resident/` 和 `/space/`。Node.js 22 或更新版本即可运行。

## 快速试用

```bash
node resident/server.js
# 另开一个终端
node space/server.js
```

Resident 页面位于 `http://127.0.0.1:8901/`，访问令牌在 `resident/data/token.txt`。Space 页面位于 `http://127.0.0.1:8902/`，默认公开目录是 `~/space-files`。这两个命令不会安装系统服务。

运行时生成的 `resident/data/` 含令牌、加密密钥和站点数据；**不要提交或公开这个目录**。仓库的 `.gitignore` 已将其排除。

## 部署到 Linux

1. 把 `resident/` 和 `space/` 分别复制到 `~/resident/`、`~/space/`。确认服务器已安装 Node.js 22+。
2. 复制 `deploy/*.service` 到 `~/.config/systemd/user/`。先检查单元中的 `ExecStart`：示例使用 `/usr/bin/node`，如果 `command -v node` 显示其他路径，请改成实际绝对路径。
3. 启动服务：

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now resident space
   loginctl enable-linger "$USER"  # 如需退出登录后继续运行
   ```

4. 把 `deploy/nginx-locations.conf` 中两段 `location` 加入你的 HTTPS `server` 块，运行 `sudo nginx -t && sudo systemctl reload nginx`。`proxy_pass` 后的斜杠不可省略。若使用 Debian 默认站点文件，也可用各目录的 `install-nginx.py`；它们只修改 nginx 站点配置，支持用 `NGINX_CONF` 环境变量指定文件，并会备份、验证及在语法失败时回滚。
5. 打开 `https://你的域名/resident/`，输入 `~/resident/data/token.txt` 中的令牌。下载空间位于 `https://你的域名/space/`。

`SPACE_ROOT` 可指定下载目录，默认 `~/space-files`。`PORT`、`HOST` 可调整监听地址和端口。设置 `SERVE_WEB=0` 可关闭 Resident 网页，保留 API 和扩展管理界面。若设置 `SERVE_WEB=0`，扩展需要手动填写令牌，无法从网页自动读取。

## 浏览器扩展

在 Chrome、Edge 或 Brave 的扩展页面启用开发者模式，选择“加载已解压的扩展程序”，指向 `resident/extension/`。该目录也提供 Windows、macOS、Linux 的安装辅助脚本；脚本只复制扩展文件并打开扩展管理页，仍需手动加载。

首次使用时，在扩展的“服务设置”填写**你自己的** `https://你的域名/resident`。随后可以手动输入令牌，或先在同一浏览器打开并登录该服务页面，再点“自动连接”。自动连接只查找与所填服务地址同源的 `/resident/` 页面。远程服务必须使用 HTTPS；本机 `localhost`、`127.0.0.1` 可用 HTTP。

在目标网站登录后打开扩展，选择一个常驻站，点击“写入并检测”；也可新建站点或只复制 Cookie。详细说明见 [扩展文档](resident/extension/README.md)。

## Resident API

除 `/api/health` 与 `/api/summary` 外，请求都要携带 `X-Token: <令牌>` 或 `Authorization: Bearer <令牌>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/sites` | 列出站点和状态 |
| POST | `/api/sites` | 新建站点 |
| GET / PATCH / DELETE | `/api/sites/:id` | 查看、修改、删除站点；`?reveal=1` 返回解密后的凭据 |
| POST | `/api/sites/:id/check` | 立即检测登录态 |
| GET / POST | `/api/sites/:id/fetch` | 携带已保存的凭据读取内容或发起请求 |

通过 nginx 访问时，给上述路径加 `/resident` 前缀。例如：

```bash
TOKEN=$(cat ~/resident/data/token.txt)
curl -H "X-Token: $TOKEN" https://你的域名/resident/api/sites
```

`fetch` 支持相对路径或绝对 URL。目标必须与站点配置的**主机名和端口完全一致**；HTTPS 站点不能降级为 HTTP，跨主机跳转会中止。文本以 `text` 返回，二进制以 `bodyBase64` 返回；默认上限 8 MiB，最大 32 MiB。Cookie 和额外请求头在磁盘上使用 AES-256-GCM 加密，密钥单独保存在 `resident/data/secret.key`。

## 安全边界

- **Space 没有身份验证，下载和删除都对能访问 `/space/` 的人开放，删除没有回收站。** 不要把它暴露给不可信用户，也不要把唯一副本放进去。`noindex` 和隧道本身都不能代替访问控制。
- Resident 令牌相当于读取与使用所托管登录态的权限。请使用 HTTPS、限制服务访问范围，并妥善保管令牌和备份。加密存储不能防止能同时读取数据和密钥的服务器使用者。
- 扩展需要 `cookies` 和 `<all_urls>` 权限来读取当前网页的 Cookie；只有用户点击写入时才会把 Cookie 发送到配置的 Resident 服务。请只连接你信任的服务。
- Resident 是 HTTP 客户端，不是完整浏览器。需要 JavaScript 挑战、动态令牌或绑定 IP 的站点可能无法保活。

## 备份与许可证

迁移或备份 Resident 时要一起保存整个 `resident/data/`，尤其是 `secret.key`；丢失密钥就无法解密已有凭据。Space 文件位于 `SPACE_ROOT`，需要单独备份。

本项目采用 [MIT License](LICENSE)。欢迎通过 Issue 或 Pull Request 反馈问题与改进；提交问题时请勿附上真实 Cookie、令牌或站点数据。
