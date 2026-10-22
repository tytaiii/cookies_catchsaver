# Cookie Catchsaver

**English** · [简体中文](README.zh-CN.md)

Cookie Catchsaver is an **always-on website session bridge for local and cloud AI agents**. Deploy Resident on a server or a small always-on computer, including a handheld PC, so an agent or a cloud-based agent management hub can request website files and information through an authenticated API without signing in through a browser for every task.

- **Resident** stores website cookies or request headers, periodically visits configured pages to check and help keep sessions active, and fetches content for authorized agents. A Chromium extension captures cookies from the current tab, including HttpOnly cookies, and lets you update and manage the saved sessions from a handheld PC or another computer.
- **Space** is an optional browsable file download page for a directory on the host.

Both services use Node.js built-ins only. No npm packages or build step are required.

> **Space access:** set `SPACE_TOKEN` to protect the shared directory. When it is unset, anyone who can access `/space/` can download **and permanently delete** its files. Anyone with the token also has deletion permission; keep backups elsewhere.

## How agents use it

```text
Browser on a handheld or desktop host → Cookie Helper → Resident on an always-on server
Cloud/local AI agent or management hub → token-protected Resident API → target website
```

Resident holds the website session on the always-on host. Agents call `/api/sites/:id/fetch` to retrieve pages, files, or other information using the stored credentials. The periodic checks can extend sessions with idle timeouts, but cannot override a site's absolute expiration or other authentication rules. Agent integration is through the HTTP API; no specific agent framework is required.

## Session renewal and alerts (1.3.0)

Resident saves session cookies returned in `Set-Cookie`, including during redirects, so rotated credentials can be reused by the next request. Requests to the same configured site run sequentially to protect rotating sessions; different sites can run in parallel. Cookie renewal is saved before reading the remaining response, and an old response cannot replace credentials that you manually updated in the meantime. The extension also sends the current browser's User-Agent and basic `sec-ch-ua` hints when writing cookies. These help reproduce HTTP requests, but cannot reproduce a browser's TLS fingerprint or bypass a site's authentication rules.

Optional email alerts report expired sessions or invalid URLs. Resident also supports authentication failure limits, optional access-token expiration, and binding browser API access to the first authenticated extension. Space adds optional token protection for its listing, downloads, and deletion endpoints.

## What is included

| Path | Purpose |
| --- | --- |
| `resident/server.js` | Encrypted credential storage, scheduled session checks, and authenticated HTTP API |
| `resident/public/` | Optional web management page |
| `resident/extension/` | Chromium extension for capturing cookies and managing sites |
| `space/server.js` | Directory listing, file downloads, and deletion |
| `deploy/` | Example user-level systemd units and nginx locations |

Resident and Space listen on `127.0.0.1` by default, on ports 8901 and 8902 respectively. Use Node.js 22 or newer. For remote access, place them behind HTTPS and route `/resident/` and `/space/` to the corresponding local services.

## Try it locally

Run each service in a separate terminal:

```bash
node resident/server.js
node space/server.js
```

Open Resident at `http://127.0.0.1:8901/` and Space at `http://127.0.0.1:8902/`. Resident creates an access token in `resident/data/token.txt`; Space serves `~/space-files` unless `SPACE_ROOT` is set. These commands do not install system services.

Resident also creates `resident/data/secret.key` and `resident/data/sites.json`. **Never publish `resident/data/`**: it contains the token, encryption key, and site data. The directory is excluded by `.gitignore`.

## Deploy on Linux

1. Copy `resident/` to `~/resident/` and `space/` to `~/space/`. Install Node.js 22 or newer.
2. Copy `deploy/*.service` to `~/.config/systemd/user/`. Check `ExecStart` first: the examples use `/usr/bin/node`; replace it with the absolute path shown by `command -v node` if yours differs.
3. Start the services:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now resident space
   loginctl enable-linger "$USER"  # optional: keep running after logout
   ```

4. Add the two locations in `deploy/nginx-locations.conf` to your HTTPS nginx `server` block, then run `sudo nginx -t && sudo systemctl reload nginx`. Keep the trailing slash in each `proxy_pass`. On a Debian-style default site, the optional `install-nginx.py` scripts can add the locations; they back up the config and roll back if `nginx -t` fails. Set `NGINX_CONF` to target another config file.
5. Visit `https://your-domain.example/resident/` and enter the token from `~/resident/data/token.txt`. Space is at `https://your-domain.example/space/`.

Use `SPACE_ROOT` to choose the shared directory; its default is `~/space-files`. `PORT` and `HOST` control each service's listener. Set `SERVE_WEB=0` for an API-only Resident instance; in that mode, enter the token manually in the extension because there is no web page from which to retrieve it.

## Optional configuration

Set these environment variables in the relevant systemd service or shell, then restart the service:

| Setting | Service | Default / purpose |
| --- | --- | --- |
| `SITE_LABEL` | Both | `Resident` / `Space`; name shown on the web page |
| `SPACE_TOKEN` | Space | Unset; set a strong token to require access authorization |
| `TOKEN_MAX_AGE_DAYS` | Resident | `0` (disabled); maximum age of the Resident access token |
| `AUTH_MAX_FAILS` | Resident | `10`; failed attempts before a temporary block |
| `AUTH_WINDOW_SEC` | Resident | `60`; failure-counting window |
| `AUTH_BLOCK_SEC` | Resident | `300`; block duration, including requests with a correct token |
| `TRUST_PROXY` | Resident | `0`; set to `1` only behind a trusted proxy that replaces `CF-Connecting-IP` |

Without `TRUST_PROXY=1`, limits use the direct connection's IP; behind nginx this can group clients together. If a Resident token expires, delete `resident/data/token.txt` and restart Resident to generate a fresh token and creation time, then update your clients.

When `SPACE_TOKEN` is set, agents can send `X-Token: <space-token>`. For browser access, open `https://your-domain.example/space/?token=<URL-encoded-token>` once. Space sets an HttpOnly, SameSite cookie (Secure on HTTPS) and redirects to remove the token from the visible URL. The initial URL can still appear in browser history or proxy logs. `/health` remains public.

### Email alerts

Copy `deploy/mail.example.json` to `~/resident/data/mail.json`, replace the example SMTP account, sender, recipient, and app password, restrict the file to mode `600`, then restart Resident. No email is sent unless a complete configuration has `enabled: true`. The built-in SMTP client supports implicit TLS (usually port 465) and AUTH LOGIN; STARTTLS on port 587 is not supported.

```bash
chmod 600 ~/resident/data/mail.json
systemctl --user restart resident
curl -X POST -H "X-Token: $(cat ~/resident/data/token.txt)" \
  http://127.0.0.1:8901/api/mail/test
```

Successful alerts for the same expired/invalid state are rate limited to one per `minIntervalHours` (default 6); a failed delivery can be retried by the next session check. A successful session check resets the alert state. After the first authenticated extension request, its ID is saved in `resident/data/extensions.json`. To replace that extension, stop Resident, remove this file, restart Resident, and connect with the intended extension.

## Chromium extension

Open the extensions page in Chrome, Edge, or Brave, enable developer mode, and load `resident/extension/` as an unpacked extension. Optional Windows, macOS, and Linux helper scripts copy the extension to a stable location and open the extensions page; you still load it manually.

On first use, enter **your own** service URL, such as `https://your-domain.example/resident`, in the extension's service settings. Either paste the token manually or sign in to the Resident web page in the same browser and click **Auto connect**. Auto connect only reads the configured service page on the configured origin. For a local service without nginx, use `http://127.0.0.1:8901` as the service URL and sign in at its root page. Remote service URLs must use HTTPS; HTTP is accepted for local `localhost` and `127.0.0.1` instances.

After signing in to a target website, open the extension, select or create a Resident site, and choose **Write and check**. You can also copy the cookie header without uploading it. See the [English extension guide](resident/extension/README.en.md) for permissions and details.

## Resident API

All endpoints except `/api/health` and `/api/summary` require `X-Token: <token>` or `Authorization: Bearer <token>`.

| Method | Path | Action |
| --- | --- | --- |
| GET | `/api/sites` | List sites and their status |
| POST | `/api/sites` | Create a site |
| GET / PATCH / DELETE | `/api/sites/:id` | Read, update, or delete a site; `?reveal=1` returns decrypted credentials |
| POST | `/api/sites/:id/check` | Check a session immediately |
| GET / POST | `/api/sites/:id/fetch` | Make a request using saved credentials |
| GET | `/api/mail/status` | Check whether email alerts are configured |
| POST | `/api/mail/test` | Send a test message using the configured SMTP account |

When using nginx, prefix these paths with `/resident`:

```bash
TOKEN=$(cat ~/resident/data/token.txt)
curl -H "X-Token: $TOKEN" https://your-domain.example/resident/api/sites
```

`fetch` accepts a relative path or absolute URL. The destination must match the configured site's **hostname and port exactly**. HTTPS cannot be downgraded to HTTP, and redirects to another host are stopped. Text is returned in `text`; binary content is returned in `bodyBase64`. The default response limit is 8 MiB, with a 32 MiB maximum. Cookies and custom headers are encrypted on disk with AES-256-GCM; the key lives in `resident/data/secret.key`.

## Security and limitations

- **Space is public unless `SPACE_TOKEN` is set, and has no recycle bin.** Access to the shared directory includes deletion permission. Search-engine `noindex` and a tunnel do not provide access control. Keep backups elsewhere.
- The Resident token grants access to the stored sessions. Use HTTPS for remote access, restrict who can reach the service, and protect both the token and backups. Encryption at rest cannot protect data from someone who can read both the site data and its key.
- The extension requests `cookies` and `<all_urls>` permissions to work with sites and self-hosted service URLs. It sends cookies to the configured Resident service only after you click a write action. Connect only to a service you trust.
- Resident is an HTTP client, not a full browser. Sites that require JavaScript challenges, dynamic tokens, or IP-bound sessions may not work.
- Cookies are stored as a Cookie header per configured site, not a complete browser cookie jar. Path-specific and same-name cookies on different paths are not tracked separately. Session renewal does not override absolute expiry or browser-specific security checks.

## Upgrading to 1.3.1

Replace the code while keeping `resident/data/` and your Space files. Restart the services and reload the unpacked extension from its extensions page. For existing HTTPS nginx deployments, add `proxy_set_header X-Forwarded-Proto $scheme;` to the Space location, then validate and reload nginx so Space can set Secure cookies. The example config and newly generated locations include this header; installers leave existing locations unchanged. If TLS terminates at a trusted gateway before nginx, pass that gateway's original protocol instead.

## Verification

Run the local integration checks with `node --test` (Node.js 22+). They use temporary data and local HTTP/SMTP fixtures; no real website sessions or SMTP account are required.

## Backup and license

Back up the entire `resident/data/` directory, especially `secret.key`; without it, existing encrypted credentials cannot be recovered. Back up files under `SPACE_ROOT` separately.

Licensed under the [MIT License](LICENSE). Issues and pull requests are welcome; never include real cookies, tokens, or site data in a report.
