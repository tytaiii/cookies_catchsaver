# Resident Cookie Helper

**English** · [简体中文](README.md)

A Chromium extension that captures cookies available to the current page, including HttpOnly cookies, and writes them to **your own** Resident service. It can also manage sites, check session status, edit credentials, or copy a cookie header without uploading it.

## Install

In Chrome, Edge, or Brave, enable developer mode on the extensions page and load this directory as an unpacked extension. The optional `install-windows.bat`, `install-macos.command`, and `install-linux.sh` scripts copy the files to a stable location and open the extensions page. You must still load the extension manually.

## Connect for the first time

1. Deploy Resident behind HTTPS at `https://your-domain.example/resident/`.
2. In the extension's service settings, enter `https://your-domain.example/resident` and save. No server is preconfigured.
3. Either paste the token from `~/resident/data/token.txt`, or sign in to the Resident web page in the same browser and click **Auto connect**. Auto connect searches only `/resident/` pages on the configured origin.

Remote service URLs require HTTPS. HTTP is accepted for `localhost` and `127.0.0.1`. If `SERVE_WEB=0`, enter the token manually because the web page is disabled.

## Daily use

Open a website where you are signed in, then click the extension icon. It shows the current page's cookie count and selects a matching Resident site when possible. Check the selection before clicking **Write and check**. You can create a new site, open the management panel, or use **Copy only**.

## Permissions and data

| Permission | Why it is needed |
| --- | --- |
| `cookies` | Read cookies available to the current page, including HttpOnly cookies |
| `activeTab` | Identify the current page |
| `scripting` | Read the locally stored token from a signed-in Resident page |
| `storage` | Keep the service URL and token in this browser |
| `<all_urls>` | Support user-hosted services and target websites on different domains |

Cookies are sent to the configured Resident service only when you click a write action. **Copy only** places the cookie header on your clipboard. The token is stored in `chrome.storage.local`. Connect only to a service you trust, and avoid storing sensitive sessions on a shared computer.
