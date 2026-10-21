#!/usr/bin/env node
'use strict';

/**
 * 下载空间（Space）
 * ------------------------------------------------------------
 * 把系统盘上的一个文件夹做成公开的下载页：列目录、点文件直接下载。
 * 按用户要求：不设任何验证，拿到链接的人都能下载。
 *
 * 只监听 127.0.0.1:8902，对外由 nginx 的 /space/ 反代。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DEFAULT_ROOT = path.join(require('node:os').homedir(), 'space-files');
const ROOT = path.resolve(process.env.SPACE_ROOT || DEFAULT_ROOT);
const PORT = Number(process.env.PORT || 8902);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_DEPTH = 6;

// 页面标题和页脚里显示的名字，部署时用环境变量覆盖，比如 SITE_LABEL=example.com
const SITE_LABEL = String(process.env.SITE_LABEL || 'Space');

// 可选的访问令牌：设了 SPACE_TOKEN 就要求带令牌，不设则保持完全公开。
// 带 ?token=xxx 打开一次会种一个 cookie，之后页面里的链接都能直接用。
const ACCESS_TOKEN = String(process.env.SPACE_TOKEN || '').trim();
const COOKIE_NAME = 'space_token';
const COOKIE_MAX_AGE = 30 * 24 * 3600;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.iso': 'application/x-iso9660-image',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

function fmtTime(t) {
  try {
    return new Date(t).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** 把 URL 里的相对路径安全地映射到 ROOT 之内；越界返回 null。 */
function resolveSafe(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

let rootRealCache = null;

/** ROOT 的真实路径（解析掉 ROOT 自身的符号链接）。 */
function rootReal() {
  if (!rootRealCache) {
    fs.mkdirSync(ROOT, { recursive: true });
    rootRealCache = fs.realpathSync(ROOT);
  }
  return rootRealCache;
}

/**
 * 真实路径是否仍落在 ROOT 内。
 * 需要它是因为字符串前缀检查挡不住符号链接：目录里放一个 link -> /etc，
 * 请求 link/passwd 在字面上完全合法，但真正打开的是 /etc/passwd。
 * 这里对「已存在的部分」做 realpath，再拼上尚未创建的部分，然后比较。
 */
async function realWithinRoot(abs) {
  const root = rootReal();
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = await fsp.realpath(cur);
      const full = tail.length ? path.join(real, ...tail) : real;
      return full === root || full.startsWith(root + path.sep);
    } catch (e) {
      if (e.code !== 'ENOENT') return false;
      const up = path.dirname(cur);
      if (up === cur) return false;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
  return false;
}

/** resolveSafe + 真实路径校验，异步，所有读写删都应走这个。 */
async function resolveInside(rel) {
  const abs = resolveSafe(rel);
  if (!abs) return null;
  if (!(await realWithinRoot(abs))) return null;
  return abs;
}

/** 目录里真正位于 ROOT 内的条目（符号链接指向外面的一律跳过）。 */
async function listDir(absDir, relDir) {
  const ents = await fsp.readdir(absDir, { withFileTypes: true });
  const out = [];
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(absDir, ent.name);
    let st = null;
    try {
      st = await fsp.stat(abs);          // 跟随符号链接
      if (ent.isSymbolicLink()) {
        const real = await fsp.realpath(abs);
        if (real !== ROOT && !real.startsWith(ROOT + path.sep)) continue;
      }
    } catch {
      continue;                          // 断链/无权限，跳过
    }
    const rel = relDir ? relDir + '/' + ent.name : ent.name;
    out.push({
      name: ent.name,
      rel,
      isDir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => (b.isDir - a.isDir) || (b.mtime - a.mtime) || a.name.localeCompare(b.name));
  return out;
}

function pageHtml(relDir, items) {
  // 全部用相对链接：页面既可能挂在 /space/（nginx 反代），也可能直连 127.0.0.1:8902/
  const crumbs = [{ label: '下载空间', href: './' }];
  if (relDir) {
    let acc = '';
    for (const seg of relDir.split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + seg : seg;
      crumbs.push({ label: seg, href: '?p=' + encodeURIComponent(acc) });
    }
  }
  const crumbHtml = crumbs
    .map((c, i) => (i === crumbs.length - 1
      ? `<span class="cur">${esc(c.label)}</span>`
      : `<a href="${c.href}">${esc(c.label)}</a><span class="sep">/</span>`))
    .join('');

  const rows = items.map((it) => {
    const href = it.isDir
      ? '?p=' + encodeURIComponent(it.rel)
      : 'f?p=' + encodeURIComponent(it.rel);
    const icon = it.isDir ? '📁' : '📄';
    const meta = it.isDir ? '文件夹' : fmtSize(it.size);
    return `<div class="row">
        <a class="link" href="${href}">
          <span class="ic">${icon}</span>
          <span class="nm">${esc(it.name)}</span>
          <span class="mt">${meta}</span>
          <span class="tm">${esc(fmtTime(it.mtime))}</span>
        </a>
        <button class="del" data-rel="${esc(it.rel)}" data-dir="${it.isDir ? '1' : '0'}" title="删除">✕</button>
      </div>`;
  }).join('');

  const total = items.reduce((s, x) => s + (x.isDir ? 0 : x.size), 0);
  const up = relDir
    ? `<a class="back" href="?p=${encodeURIComponent(relDir.split('/').slice(0, -1).join('/'))}">← 上一级</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>下载空间 · ${esc(SITE_LABEL)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #250301;
    --card: rgba(255, 255, 255, 0.06);
    --card-border: rgba(255, 255, 255, 0.12);
    --text: #e6f0b0;
    --muted: rgba(230, 240, 176, 0.62);
    --dim: rgba(230, 240, 176, 0.40);
    --accent: #ff0000;
  }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    min-height: 100vh; background: var(--bg); color: var(--text);
    padding: 32px 20px 60px; display: flex; flex-direction: column; align-items: center;
  }
  .wrap { width: 100%; max-width: 820px; }
  .back { font-size: 13px; color: var(--accent); text-decoration: none; }
  header { margin: 26px 0 24px; text-align: center; }
  h1 { font-size: 30px; font-weight: 700; letter-spacing: 2px; }
  .sub { margin-top: 10px; font-size: 13px; color: var(--muted); }
  .crumbs { margin: 0 0 14px; font-size: 13px; color: var(--dim); word-break: break-all; }
  .crumbs a { color: var(--accent); text-decoration: none; }
  .crumbs a:hover { text-decoration: underline; }
  .crumbs .sep { margin: 0 6px; opacity: .5; }
  .crumbs .cur { color: var(--muted); }
  .list { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; }
  .row {
    display: flex; align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    transition: background .15s;
  }
  .row:last-child { border-bottom: none; }
  .row:hover { background: rgba(255, 255, 255, 0.08); }
  .link {
    flex: 1; min-width: 0;
    display: grid; grid-template-columns: 28px 1fr auto auto; gap: 12px; align-items: center;
    padding: 12px 16px; text-decoration: none; color: inherit;
  }
  .del {
    flex: 0 0 auto; margin: 0 12px 0 0;
    width: 30px; height: 30px; border-radius: 8px;
    background: transparent; border: 1px solid var(--card-border);
    color: var(--dim); font-size: 13px; line-height: 1; cursor: pointer;
    transition: background .15s, color .15s, border-color .15s;
  }
  .del:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
  .del:disabled { opacity: .45; cursor: default; }
  .ic { font-size: 16px; }
  .nm { font-size: 14px; word-break: break-all; }
  .mt { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .tm { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .empty { padding: 34px 16px; text-align: center; font-size: 13px; color: var(--dim); }
  .back { display: inline-block; margin-bottom: 14px; }
  footer { margin-top: 26px; text-align: center; font-size: 12px; color: var(--dim); line-height: 1.8; }
  footer a { color: var(--accent); text-decoration: none; }
  @media (max-width: 560px) {
    .link { grid-template-columns: 26px 1fr auto; }
    .tm { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="../">← 返回首页</a>
  <header>
    <h1>下载空间</h1>
    <div class="sub">当前 ${items.length} 项 · 共 ${fmtSize(total)}</div>
  </header>
  ${relDir ? `<div class="crumbs">${crumbHtml}</div>` : ''}
  ${up}
  <div class="list">
    ${items.length ? rows : '<div class="empty">这个文件夹还是空的</div>'}
  </div>
  <footer>Space · ${esc(SITE_LABEL)}</footer>
</div>
<script>
  // 删除：公开操作，只做一次确认，不做权限校验
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.del');
    if (!btn) return;
    e.preventDefault();
    const rel = btn.dataset.rel;
    const isDir = btn.dataset.dir === '1';
    const tip = isDir
      ? '确定删除这个文件夹及其里面的全部内容？删了不进回收站。\\n\\n'
      : '确定删除这个文件？删了不进回收站。\\n\\n';
    if (!confirm(tip + rel)) return;
    btn.disabled = true;
    try {
      const r = await fetch('f?p=' + encodeURIComponent(rel), { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      location.reload();
    } catch (err) {
      alert('删除失败：' + err.message);
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
  res.end(body);
}

async function serveFile(req, res, abs) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile()) return sendJson(res, 404, { error: '不是文件' });

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const name = path.basename(abs);
  const encoded = encodeURIComponent(name);
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`,
    'last-modified': new Date(st.mtimeMs).toUTCString(),
    // 不缓存：这个目录里的文件经常被替换，缓存会导致下载到旧版本
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  };

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range.trim())) {
    const [s, e] = range.replace('bytes=', '').split('-');
    let start = s === '' ? null : Number(s);
    let end = e === '' ? null : Number(e);
    if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
    if (start !== null && end === null) end = st.size - 1;
    if (start === null || start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------- 汇总

/** 统计目录下所有条目数（用于删除日志）。 */
async function countEntries(dir, depth = 0) {
  if (depth > 12) return 0;
  let n = 0;
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    n += 1;
    if (e.isDirectory()) n += await countEntries(path.join(dir, e.name), depth + 1);
  }
  return n;
}

let summaryCache = { at: 0, files: 0, size: 0 };
const SUMMARY_TTL = 30 * 1000;   // 30 秒内复用，避免首页每次刷新都全盘扫

async function computeSummary() {
  let files = 0;
  let size = 0;
  const walk = async (dir, depth) => {
    if (depth > 8 || files > 50000) return;
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      try {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) {
          await walk(abs, depth + 1);
        } else {
          files += 1;
          size += st.size;
        }
      } catch {
        /* 跳过读不到的条目 */
      }
    }
  };
  await walk(ROOT, 0);
  summaryCache = { at: Date.now(), files, size };
  return summaryCache;
}

async function getSummary() {
  if (!summaryCache.at || Date.now() - summaryCache.at > SUMMARY_TTL) {
    await computeSummary();
  }
  return summaryCache;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.searchParams.get('p') || '';

    // ---- 可选鉴权（健康检查放行，方便反代探活）----
    if (ACCESS_TOKEN && u.pathname !== '/health') {
      const q = u.searchParams.get('token') || '';
      const h = String(req.headers['x-token'] || '');
      const cookies = String(req.headers.cookie || '');
      const ck = (cookies.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)')) || [])[1] || '';
      let decodedCookie = '';
      try { decodedCookie = decodeURIComponent(ck); } catch { /* 无效 Cookie 按未授权处理 */ }
      const provided = q || h || decodedCookie;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');

      if (provided !== ACCESS_TOKEN) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('需要访问令牌：在地址后面加 ?token=你的令牌 打开一次即可。\n');
      }
      if (q) {
        // 令牌在 URL 里出现过，顺手种 cookie，后续链接就不用再带
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('set-cookie',
          `${COOKIE_NAME}=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
        if (req.method === 'GET' || req.method === 'HEAD') {
          u.searchParams.delete('token');
          // 仅跳转查询串，保留反代后浏览器看到的 /space/ 前缀。
          res.writeHead(303, { location: u.search || '?' });
          return res.end();
        }
      }
    }

    const method = req.method;
    if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
      return sendJson(res, 405, { error: '只支持 GET / DELETE' });
    }

    if (u.pathname === '/health') {
      return sendJson(res, 200, { ok: true, root: ROOT });
    }

    if (u.pathname === '/api/list') {
      const abs = await resolveInside(p);
      if (!abs) return sendJson(res, 403, { error: '路径不合法' });
      try {
        const items = await listDir(abs, p.replace(/^\/+|\/+$/g, ''));
        return sendJson(res, 200, { path: p, items });
      } catch {
        return sendJson(res, 404, { error: '目录不存在' });
      }
    }

    // 公开删除：按用户要求，任何人拿到链接都能删（没有回收站）
    // 注意：必须放在 /f 的 GET 分支之前，否则会被当成下载。
    if (method === 'DELETE') {
      const abs = await resolveInside(p);
      if (!abs) return sendJson(res, 403, { error: '路径不合法' });
      if (abs === ROOT) return sendJson(res, 403, { error: '不能删除根目录' });
      try {
        const st = await fsp.lstat(abs);
        let removed = 1;
        if (st.isDirectory()) {
          // 文件夹连同里面的内容一起删（用户要求「任何人都能删」，不做非空限制）
          removed = await countEntries(abs);
          await fsp.rm(abs, { recursive: true, force: false, maxRetries: 2 });
        } else {
          await fsp.unlink(abs);
        }
        summaryCache.at = 0;
        const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').toString();
        console.log(new Date().toISOString(), `删除 ${p}（${removed} 项）  by ${ip}`);
        return sendJson(res, 200, { ok: true, deleted: p, removed });
      } catch (e) {
        const msg = e.code === 'ENOENT' ? '文件不存在'
          : e.code === 'EACCES' ? '没有权限'
            : e.code === 'EBUSY' ? '文件正被占用'
              : (e.code || e.message);
        return sendJson(res, 400, { error: msg });
      }
    }

    if (u.pathname === '/f') {
      const abs = await resolveInside(p);
      if (!abs) return sendJson(res, 403, { error: '路径不合法' });
      return await serveFile(req, res, abs);
    }

    // 公开汇总：整个目录（含子目录）的文件数与总大小，供首页卡片显示
    if (u.pathname === '/api/summary') {
      if (u.searchParams.get('fresh') === '1') summaryCache.at = 0;   // 跳过缓存
      const s = await getSummary();
      return sendJson(res, 200, { files: s.files, size: s.size, sizeText: fmtSize(s.size), at: s.at });
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      const relDir = p.replace(/^\/+|\/+$/g, '');
      const abs = await resolveInside(relDir);
      if (!abs) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('路径不合法');
      }
      let items;
      try {
        const st = await fsp.stat(abs);
        if (!st.isDirectory()) return await serveFile(req, res, abs);
        items = await listDir(abs, relDir);
      } catch {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><p style="font:16px sans-serif;color:#e6f0b0;background:#250301;padding:24px">文件夹不存在</p>');
      }
      const html = pageHtml(relDir, items);
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error(new Date().toISOString(), '处理请求出错：', e.message);
    try { sendJson(res, 500, { error: '服务器内部错误' }); } catch { /* 已发送 */ }
  }
});

fs.mkdirSync(ROOT, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(new Date().toISOString(), `下载空间服务已启动 http://${HOST}:${PORT}  root=${ROOT}`);
});
