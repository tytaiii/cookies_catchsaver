# Cookie Catchsaver

**English** · [简体中文](README.zh-CN.md)

Cookie Catchsaver combines two self-hosted Node.js services:

- **Resident** stores a website's login cookies or request headers, checks whether the session still works, and exposes an authenticated API for fetching content with those credentials. A Chromium extension can capture cookies from the current tab, including HttpOnly cookies, and send them to your own Resident instance.
- **Space** serves a directory as a browsable file download page.

Both services use Node.js built-ins only. No npm packages or build step are required.

> **Before exposing Space to the internet:** anyone who can access `/space/` can download **and permanently delete** its files. Space has no authentication. Put it behind access control or use it only on a trusted network.

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

## Chromium extension

Open the extensions page in Chrome, Edge, or Brave, enable developer mode, and load `resident/extension/` as an unpacked extension. Optional Windows, macOS, and Linux helper scripts copy the extension to a stable location and open the extensions page; you still load it manually.

On first use, enter **your own** service URL, such as `https://your-domain.example/resident`, in the extension's service settings. Either paste the token manually or sign in to the Resident web page in the same browser and click **Auto connect**. Auto connect only reads a `/resident/` page on the configured origin. Remote service URLs must use HTTPS; HTTP is accepted for local `localhost` and `127.0.0.1` instances.

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

When using nginx, prefix these paths with `/resident`:

```bash
TOKEN=$(cat ~/resident/data/token.txt)
curl -H "X-Token: $TOKEN" https://your-domain.example/resident/api/sites
```

`fetch` accepts a relative path or absolute URL. The destination must match the configured site's **hostname and port exactly**. HTTPS cannot be downgraded to HTTP, and redirects to another host are stopped. Text is returned in `text`; binary content is returned in `bodyBase64`. The default response limit is 8 MiB, with a 32 MiB maximum. Cookies and custom headers are encrypted on disk with AES-256-GCM; the key lives in `resident/data/secret.key`.

## Security and limitations

- **Space has no authentication or recycle bin.** Anyone who can reach `/space/` can delete files and folders. Search-engine `noindex` and a tunnel do not provide access control. Keep backups elsewhere.
- The Resident token grants access to the stored sessions. Use HTTPS for remote access, restrict who can reach the service, and protect both the token and backups. Encryption at rest cannot protect data from someone who can read both the site data and its key.
- The extension requests `cookies` and `<all_urls>` permissions to work with sites and self-hosted service URLs. It sends cookies to the configured Resident service only after you click a write action. Connect only to a service you trust.
- Resident is an HTTP client, not a full browser. Sites that require JavaScript challenges, dynamic tokens, or IP-bound sessions may not work.

## Backup and license

Back up the entire `resident/data/` directory, especially `secret.key`; without it, existing encrypted credentials cannot be recovered. Back up files under `SPACE_ROOT` separately.

Licensed under the [MIT License](LICENSE). Issues and pull requests are welcome; never include real cookies, tokens, or site data in a report.
