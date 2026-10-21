#!/usr/bin/env node
'use strict';

/**
 * 网站常驻（Resident）
 * ------------------------------------------------------------
 * 把一个需要登录的网站交给服务器托管：
 *   · 存下 网址 + Cookie（加密落盘）
 *   · 定时带着 cookie 访问一次，既验证有效性、也维持会话不过期
 *   · 失效时区分「网址打不开 / 网址不存在 / 登录已失效」三种原因
 *   · 暴露接口，供 AI 带 cookie 抓页面、下文件、发请求
 *
 * 只监听 127.0.0.1:8901，对外由 nginx (/resident/) 反代。
 * 认证：Authorization: Bearer <token>  或  X-Token: <token>
 * token 在 data/token.txt（首次启动自动生成，权限 600）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 常量

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sites.json');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const PUBLIC_DIR = path.join(ROOT, 'public');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8901);
const VERSION = '1.2.0';

// 管理界面现在在浏览器扩展里。把 SERVE_WEB 设成 0 可以让服务端只提供接口，
// 不再对外给出 /resident/ 这个页面（纯接口模式，更轻）。
const SERVE_WEB = String(process.env.SERVE_WEB == null ? '1' : process.env.SERVE_WEB) !== '0';

const DEFAULT_INTERVAL_MIN = 30;
const MIN_INTERVAL_MIN = 5;
const CHECK_TIMEOUT_MS = 25000;
const CHECK_BODY_CAP = 192 * 1024;   // 检测时只读页面开头，够判断登录页
const FETCH_DEFAULT_CAP = 8 * 1024 * 1024;
const FETCH_MAX_CAP = 32 * 1024 * 1024;

const LOGIN_PATH_RE = /\/(login|log-in|signin|sign-in|sign_on|auth|sso|passport|uc\/login|account\/login|session\/new|users\/sign_in)(\/|$|\?)/i;
const LOGIN_TEXT_RE = /(登录|登入|sign in|log in|login)/i;

// ---------------------------------------------------------------- 加密

let SECRET = null;

function loadSecret() {
  if (SECRET) return SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(KEY_FILE)) {
    SECRET = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (SECRET.length !== 32) throw new Error('secret.key 长度异常，应为核心 32 字节');
  } else {
    SECRET = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, SECRET.toString('hex'), { mode: 0o600 });
    log('已生成 data/secret.key（用于加密 cookie）');
  }
  return SECRET;
}

function seal(plain) {
  if (!plain) return '';
  const key = loadSecret();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

function unseal(blob) {
  if (!blob) return '';
  const [v, ivb, tagb, ctb] = String(blob).split('.');
  if (v !== 'v1' || !ivb || !tagb) throw new Error('密文格式不正确');
  const key = loadSecret();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
  d.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctb || '', 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- 工具

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const randomId = () => crypto.randomBytes(8).toString('hex');

function loadToken() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  log('已生成 data/token.txt');
  return t;
}

const TOKEN = loadToken();

// ---------------------------------------------------------------- GitHub 设备码登录
//
// 用 OAuth App 的 client ID 走 RFC 8628 设备码流程：
//   1. POST github.com/login/device/code 拿 user_code + device_code
//   2. 用户在 github.com/login/device 输入 user_code
//   3. 本服务轮询 login/oauth/access_token，拿到 access_token
// token 只存在内存里传给前端，落盘的是写进站点的请求头（加密）。

const OAUTH_FILE = path.join(DATA_DIR, 'oauth.json');
let oauthCfg = { clientId: '' };
const oauthSessions = new Map();

try {
  if (fs.existsSync(OAUTH_FILE)) {
    const j = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
    if (j && typeof j.clientId === 'string') oauthCfg.clientId = j.clientId;
  }
} catch { /* 忽略损坏的配置 */ }

function saveOauthCfg() {
  fs.writeFileSync(OAUTH_FILE, JSON.stringify(oauthCfg, null, 2), { mode: 0o600 });
}

function ghPost(url, form) {
  return fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'tytai-resident',
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.json());
}

function cleanupOauth() {
  const now = Date.now();
  for (const [id, s] of oauthSessions) {
    if (now - s.createdAt > 20 * 60 * 1000) oauthSessions.delete(id);
  }
}

function tokenOk(req) {
  const h = req.headers['authorization'] || '';
  let got = '';
  if (h.toLowerCase().startsWith('bearer ')) got = h.slice(7).trim();
  if (!got) got = String(req.headers['x-token'] || '').trim();
  if (!got) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 存储

let sites = [];
let writeChain = Promise.resolve();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DATA_FILE)) {
    sites = [];
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    sites = Array.isArray(raw.sites) ? raw.sites : [];
  } catch (e) {
    log('读取 data/sites.json 失败，按空表启动：', e.message);
    sites = [];
  }
}

function save() {
  const snapshot = JSON.stringify({ version: 1, sites }, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch((e) => log('写数据文件失败：', e.message));
  return writeChain;
}

const findSite = (id) => sites.find((s) => s.id === id);

function publicView(s, { reveal = false } = {}) {
  const o = {
    id: s.id,
    name: s.name,
    url: s.url,
    enabled: s.enabled !== false,
    intervalMin: s.intervalMin || DEFAULT_INTERVAL_MIN,
    hasCookie: Boolean(s.cookie),
    hasHeaders: Boolean(s.headers),
    hasUA: Boolean(s.ua),
    expect: s.expect || '',
    createdAt: s.createdAt,
    last: s.last || { status: 'unknown' },
  };
  if (reveal) {
    try {
      o.cookie = unseal(s.cookie);
    } catch {
      o.cookie = '';
      o.cookieError = true;
    }
    o.ua = s.ua || '';
    try {
      o.headers = s.headers ? unseal(s.headers) : '';
    } catch {
      o.headers = '';
      o.headersError = true;
    }
  }
  return o;
}

// ---------------------------------------------------------------- 抓取

/**
 * 判断目标地址是否就是站点本身。
 *
 * 这里刻意收得很紧：主机名必须完全一致（不认 www 变体、也不认上级域名或子域名），
 * 端口必须一致，协议不允许从 https 降级到 http。原因是请求会带上已保存的 cookie
 * 和自定义请求头，任何域名差异都可能把凭据交给别的服务。
 * http 站点升级到同主机的 https 是允许的。
 */
function sameTarget(target, siteUrl) {
  let a;
  let b;
  try {
    a = new URL(target);
    b = new URL(siteUrl);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if ((a.port || '') !== (b.port || '')) return false;
  if (b.protocol === 'https:' && a.protocol !== 'https:') return false;
  return true;
}

async function readCap(res, cap) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > cap) {
      chunks.push(value.subarray(0, cap - total));
      total = cap;
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { buf: Buffer.concat(chunks), truncated };
}

async function requestFollow(startUrl, opts) {
  const { cookie, ua, extraHeaders, method = 'GET', body, contentType, timeoutMs = CHECK_TIMEOUT_MS, maxHops = 5, cap } = opts;
  let url = startUrl;
  let m = method;
  let b = body;
  let ct = contentType;
  const chain = [];

  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': ua || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    };
    // 站点自定义请求头（如 Authorization: Bearer <token>），可以覆盖上面的默认值
    if (extraHeaders && typeof extraHeaders === 'object') {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (k && v != null) headers[k] = String(v);
      }
    }
    if (cookie) headers.cookie = cookie;
    if (ct) headers['content-type'] = ct;

    const res = await fetch(url, {
      method: m,
      headers,
      body: b,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    chain.push({ url, status: res.status });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      if (!loc) return { res: { status: res.status, headers: res.headers }, finalUrl: url, chain, noBody: true };
      const next = new URL(loc, url);
      if (!sameTarget(next.toString(), startUrl)) {
        return { res: { status: res.status, headers: res.headers }, finalUrl: url, chain, noBody: true, crossOrigin: next.toString() };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
        m = 'GET';
        b = undefined;
        ct = undefined;
      }
      url = next.toString();
      continue;
    }

    const { buf, truncated } = await readCap(res, cap ?? FETCH_DEFAULT_CAP);
    return {
      res: { status: res.status, headers: res.headers },
      finalUrl: url,
      chain,
      buf,
      truncated,
    };
  }
  throw new Error('重定向次数过多');
}

function looksLikeLoginPage(html) {
  if (!html) return false;
  const hasPassword = /<input[^>]+type\s*=\s*["']?password/i.test(html);
  if (!hasPassword) return false;
  const title = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  return hasPassword && (LOGIN_TEXT_RE.test(title) || html.length < 60 * 1024);
}

function extractTitle(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// ---------------------------------------------------------------- 检测

// undici 把连接类错误包在 TypeError('fetch failed') 的 cause / AggregateError 里，
// 这里把真实错误码挖出来，否则只能看到一句没用的 "fetch failed"。
const CONNECT_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/;

function describeFetchError(e) {
  const bag = [];
  const push = (x) => { if (x) bag.push(x); };
  push(e && e.cause);
  if (Array.isArray(e?.cause?.errors)) e.cause.errors.forEach(push);
  push(e);
  let code = '';
  let detail = '';
  for (const x of bag) {
    if (!code && x.code) code = String(x.code);
    if (!detail && x.message) detail = String(x.message);
  }
  const timeout = e?.name === 'TimeoutError' || /TIMEOUT/i.test(code) || /timed? ?out/i.test(detail);
  return { timeout, code, detail: detail.slice(0, 140) };
}

const checking = new Set();

async function checkSite(site, { force = false } = {}) {
  if (checking.has(site.id) && !force) return site.last;
  checking.add(site.id);
  const started = Date.now();
  const prev = site.last || {};
  site.last = { ...prev, status: 'checking', at: prev.at || null };
  try {
    let cookie = '';
    try {
      cookie = unseal(site.cookie);
    } catch (e) {
      log('解不开 cookie：', site.name, e.message);
    }

    const r = await requestFollow(site.url, {
      cookie,
      ua: site.ua,
      extraHeaders: siteHeaders(site),
      cap: CHECK_BODY_CAP,
    });

    const httpStatus = r.res.status;
    const html = r.buf ? r.buf.toString('utf8') : '';
    const title = extractTitle(html);
    const finalUrl = r.finalUrl;
    const finalPath = (() => { try { return new URL(finalUrl).pathname + new URL(finalUrl).search; } catch { return finalUrl; } })();

    let status = 'valid';
    let reason = '';

    if (r.crossOrigin) {
      status = 'expired';
      reason = `被重定向到站外 ${r.crossOrigin}（通常是被踢到 SSO/登录页）`;
    } else if (httpStatus === 401 || httpStatus === 403) {
      status = 'expired';
      reason = `HTTP ${httpStatus}：站点拒绝了当前登录态`;
    } else if (httpStatus === 404) {
      status = 'invalid';
      reason = 'HTTP 404：网址不存在（配置的地址可能已变）';
    } else if (httpStatus === 429) {
      status = 'unreachable';
      reason = 'HTTP 429：被站点限流，稍后再试';
    } else if (httpStatus >= 500) {
      status = 'unreachable';
      reason = `HTTP ${httpStatus}：站点自身故障`;
    } else if (httpStatus >= 400) {
      status = 'invalid';
      reason = `HTTP ${httpStatus}：请求被拒绝，网址可能不正确`;
    } else if (finalUrl !== site.url && LOGIN_PATH_RE.test(finalPath)) {
      status = 'expired';
      reason = `被跳转到登录页 ${finalPath}`;
    } else if (site.expect) {
      if (html.includes(site.expect)) {
        status = 'valid';
        reason = `命中登录特征串`;
      } else {
        status = 'expired';
        reason = `页面里找不到特征串「${site.expect}」，可能已退出登录`;
      }
    } else if (looksLikeLoginPage(html)) {
      status = 'expired';
      reason = '返回的是登录页（页面里有密码框）';
    } else {
      status = 'valid';
      reason = '可访问';
    }

    site.last = {
      status,
      reason,
      at: new Date().toISOString(),
      httpStatus,
      finalUrl,
      title,
      ms: Date.now() - started,
    };
  } catch (e) {
    const { timeout, code, detail } = describeFetchError(e);
    // 连不上（DNS/拒绝连接/超时/证书）统一算「打不开」，其余算「未知」
    const down = timeout || CONNECT_CODES.test(code) || /CERT|TLS|SSL/i.test(code);
    site.last = {
      status: down ? 'unreachable' : 'unknown',
      reason: timeout ? `超时（>${Math.round(CHECK_TIMEOUT_MS / 1000)}s）`
        : down ? `连不上（${code || detail}）`
        : `请求失败（${code || detail}）`,
      at: new Date().toISOString(),
      ms: Date.now() - started,
    };
  } finally {
    checking.delete(site.id);
  }
  await save();
  return site.last;
}

// ---------------------------------------------------------------- 调度

function scheduleLoop() {
  const tick = async () => {
    const now = Date.now();
    for (const s of sites) {
      if (s.enabled === false) continue;
      const lastAt = s.last?.at ? Date.parse(s.last.at) : 0;
      const interval = Math.max(MIN_INTERVAL_MIN, Number(s.intervalMin) || DEFAULT_INTERVAL_MIN) * 60000;
      if (!lastAt || now - lastAt >= interval) {
        await checkSite(s).catch((e) => log('定时检测异常：', e.message));
      }
    }
  };
  setTimeout(() => { tick(); }, 3000);
  setInterval(tick, 60 * 1000);
}

// ---------------------------------------------------------------- 路由

function validateSiteInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = String(input.name || '').trim().slice(0, 60);
  }
  if (!partial || input.url !== undefined) {
    const u = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw Object.assign(new Error('网址必须以 http:// 或 https:// 开头'), { status: 400 });
    try { new URL(u); } catch { throw Object.assign(new Error('网址格式不正确'), { status: 400 }); }
    out.url = u;
  }
  if (!partial || input.cookie !== undefined) {
    out.cookie = String(input.cookie || '').trim().replace(/^cookie:\s*/i, '');
    if (out.cookie.length > 200000) throw Object.assign(new Error('Cookie 过长（>200000 字符）'), { status: 400 });
  }
  if (!partial || input.ua !== undefined) out.ua = String(input.ua || '').trim().slice(0, 400);
  if (!partial || input.headers !== undefined) {
    const raw = String(input.headers || '').trim().slice(0, 8000);
    const { headers, bad } = parseHeaders(raw);
    if (bad.length) {
      throw Object.assign(new Error(
        '这些额外请求头解析不了（要写成 `名字: 值`，一行一个）：' + bad.slice(0, 3).join(' / ')
      ), { status: 400 });
    }
    out.headers = Object.keys(headers).map((k) => `${k}: ${headers[k]}`).join('\n');
  }
  if (!partial || input.expect !== undefined) out.expect = String(input.expect || '').trim().slice(0, 200);
  if (!partial || input.intervalMin !== undefined) {
    const n = Number(input.intervalMin);
    out.intervalMin = Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_MIN, Math.min(1440, Math.round(n))) : DEFAULT_INTERVAL_MIN;
  }
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  return out;
}

// ---------------------------------------------------------------- cookie 输入
//
// 支持三种粘贴方式：
//   1. 请求头            MoodleSession=xxx; MOODLEID1_=yyy
//   2. 插件导出的表格     Tab 分隔：名称 / 值 / 域 / 路径 / 过期 / 大小 …
//   3. Netscape cookies.txt  域 \t TRUE/FALSE \t 路径 \t 安全 \t 过期 \t 名称 \t 值

const COOKIE_NAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;
const DOMAIN_RE = /^\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;   // 结尾必须是字母 TLD，避免把 1.6KB 当域名
const EXPIRY_RE = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;

/** 一行切成列：优先 tab，其次「两个以上空格」，最后退回单个空格（tab 常被聊天框吃掉）。 */
function splitCols(line) {
  let cols = line.split('\t').map((s) => s.trim());
  if (cols.filter(Boolean).length >= 3) return cols.filter(Boolean);
  cols = line.split(/\s{2,}/).map((s) => s.trim());
  if (cols.filter(Boolean).length >= 3) return cols.filter(Boolean);
  cols = line.split(/\s+/).map((s) => s.trim());
  return cols.filter(Boolean);
}

/**
 * 解析 cookie 表格。
 * 返回 { rows, header, domains, merged, recovered }
 *   rows   = 能看出「名字 + 域名」的记录数
 *   header = 域匹配、未过期的 cookie 拼成的请求头
 *   merged = 多行被并成一行且没能重建
 */
function parseCookieTable(text, targetUrl) {
  let host = '';
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { /* 忽略 */ }

  const lines = String(text)
    .replace(/\u200b/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const picked = new Map();
  const domains = new Set();
  let rows = 0;
  let maxCols = 0;
  let merged = false;      // 一行里出现多个域名 → 多半是多行被并成一行
  let recovered = false;

  const accept = (rawName, value, domain, expiry) => {
    const name = String(rawName || '').replace(/^[^A-Za-z0-9_.-]+/, '');   // 去掉行首的 ✓ / 空白
    if (/^(name|名称)$/i.test(name)) return;            // 表头行
    if (!COOKIE_NAME_RE.test(name)) return;
    if (!DOMAIN_RE.test(domain)) return;

    rows += 1;
    const d = domain.replace(/^\./, '').toLowerCase();
    domains.add(d);

    if (host && host !== d && !host.endsWith('.' + d)) return;   // 别的域名

    if (EXPIRY_RE.test(String(expiry || ''))) {
      const t = Date.parse(String(expiry).replace(/\//g, '-'));
      if (!Number.isNaN(t) && t < Date.now()) return;            // 已过期
    }

    picked.set(name, String(value == null ? '' : value).trim());
  };

  // 情形一：整张表被粘成了一行（换行丢了，tab 还在）→ 按记录结构重建
  if (lines.length === 1) {
    const cells = splitCols(lines[0]);
    maxCols = cells.length;
    if (cells.length >= 8) {
      const recs = recoverStream(cells);
      if (recs.length >= 2) {
        recovered = true;
        for (const r of recs) accept(r.name, r.value, r.domain, r.expiry);
      }
    }
  }

  // 情形二：正常的多行表格
  if (!recovered) {
    for (const line of lines) {
      const cols = splitCols(line);
      maxCols = Math.max(maxCols, cols.length);
      if (cols.length < 3) continue;
      if (cols.filter((c) => DOMAIN_RE.test(c)).length > 1) merged = true;

      let name, value, domain, expiry = '';

      if (cols.length >= 7 && /^(TRUE|FALSE)$/i.test(cols[1]) && DOMAIN_RE.test(cols[0])) {
        // Netscape cookies.txt: 域 \t flag \t 路径 \t 安全 \t 过期 \t 名字 \t 值
        domain = cols[0]; expiry = cols[4]; name = cols[5]; value = cols[6];
      } else {
        // 通用表格：在列里找域名，域名前面两列当「名字 / 值」
        let di = -1;
        for (let i = 2; i < cols.length; i++) {
          if (DOMAIN_RE.test(cols[i])) { di = i; break; }
        }
        if (di < 2) continue;
        domain = cols[di];
        name = cols[di - 2];
        value = cols[di - 1];
        expiry = cols.slice(di + 1).find((c) => EXPIRY_RE.test(c)) || '';
      }

      accept(name, value, domain, expiry);
    }
  }

  return {
    rows,
    domains: [...domains],
    merged,
    recovered,
    singleLine: !recovered && lines.length === 1 && maxCols >= 8,
    header: [...picked].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

// 粘连单元格的拆解规则：「112 B ai_session…」「✓ FedAuth」「Lax rtFa」
const GLUED_RE = /^((?:\d+(?:\.\d+)?\s?[KMG]?B|\d+\s?B|✓+|✗|Lax|Strict|None|会话))\s+(.+)$/;

function expandTokens(cells) {
  const out = [];
  for (const cell of cells) {
    let c = String(cell).trim();
    for (let guard = 0; guard < 6; guard += 1) {
      const m = c.match(GLUED_RE);
      if (!m) break;
      out.push(m[1]);
      c = m[2].trim();
    }
    out.push(c);
  }
  return out;
}

/** 从「被并成一行」的单元格流里，按 名字/值/域/路径/过期 的规律重建记录。 */
function recoverStream(cells) {
  const t = expandTokens(cells);
  const recs = [];
  let i = 0;
  while (i < t.length - 3) {
    if (COOKIE_NAME_RE.test(t[i])
      && !DOMAIN_RE.test(t[i + 1])
      && DOMAIN_RE.test(t[i + 2])
      && t[i + 3].startsWith('/')) {
      recs.push({ name: t[i], value: t[i + 1], domain: t[i + 2], expiry: t[i + 4] || '' });
      i += 3;
    } else {
      i += 1;
    }
  }
  return recs;
}

/**
 * 判断一段文本是不是「现成的 Cookie 请求头」：
 * 单行、没有 tab、每个分号段都是 name=value（值里可以有 = 号，比如 base64 的 `==`）。
 */
function looksLikeCookieHeader(text) {
  const t = String(text).trim();
  if (!t || !t.includes('=') || t.includes('\t')) return false;
  if (t.split(/\r?\n/).filter((l) => l.trim()).length > 1) return false;
  return t.split(';').every((seg) => {
    const s = seg.trim();
    if (!s) return true;
    if (!/^[^=\s;]+=/.test(s)) return false;   // 名字里不能有空格/等号
    return !/;\s*[^=;\s]+\s/.test(s);          // 不应该出现「没等号的分号段」
  });
}

/** 把用户粘贴的内容统一成能直接发出去的 Cookie 请求头。 */
function finalizeCookie(raw, targetUrl) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';

  // 本来就是标准请求头 → 直接收下，别再当表格解析
  // （扩展、curl 复制出来的都是这种；cookie 一多，单行 + 列数多会误判成「表格被挤成一行」）
  if (looksLikeCookieHeader(text)) {
    return text.replace(/\r?\n/g, '; ').replace(/;\s*$/, '').trim();
  }

  const host = (() => { try { return new URL(targetUrl).hostname; } catch { return targetUrl || ''; } })();

  // 先试着当表格解析：只要认出「名字 + 域名」的行，就走表格分支；
  // 认不出（比如本来就是 name=value 请求头）再退回请求头解析。
  {
    const r = parseCookieTable(text, targetUrl);

    // 整张表被挤成一行、且没能重建记录 → 不能只取第一条了事
    if (r.singleLine) {
      throw Object.assign(new Error(
        '粘贴的内容像是一整行（换行丢了），按结构也没能还原出多条记录。' +
        '请回到 Cookie 插件重新复制（每行一个 cookie），或者只复制关键几行（FedAuth、rtFa、SPA_RT 这类）。'
      ), { status: 400 });
    }

    if (r.merged) {
      throw Object.assign(new Error(
        '看起来多行被并成了一行（一行里出现了多个域名），这样只能取到第一条 cookie。' +
        '请重新复制，确保每个 cookie 单独一行；或者直接粘贴 `名字=值; 名字=值` 形式的请求头。'
      ), { status: 400 });
    }

    if (r.header) return r.header;

    if (r.rows > 0) {
      throw Object.assign(new Error(
        `表格认出了 ${r.rows} 行，域名有：${r.domains.join('、') || '（无）'}；` +
        `但和当前网址的域名 ${host} 都对不上。` +
        '请确认这个常驻站的网址填的是同一个站点（比如 gla.sharepoint.com），或者重新复制含该域名的 cookie 行。'
      ), { status: 400 });
    }
  }

  const header = text.replace(/\r?\n/g, '; ').replace(/;\s*$/, '').trim();
  if (!/=/.test(header)) {
    throw Object.assign(new Error(
      'Cookie 要写成 name=value 的形式，例如 MoodleSession=xxxx。' +
      '你现在贴的看起来只有值、没有 cookie 名字 —— 可以复制整行 Cookie 请求头，' +
      '或者直接粘贴 Cookie 插件导出的表格。'
    ), { status: 400 });
  }
  return header;
}

const BAD_HEADER_RE = /^(host|content-length|connection|transfer-encoding)$/i;

/** 解析「一行一个请求头」的文本：Authorization: Bearer xxx */
function parseHeaders(text) {
  const out = {};
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) { bad.push(line); continue; }
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(k) || BAD_HEADER_RE.test(k)) { bad.push(line); continue; }
    out[k] = v;
  }
  return { headers: out, bad };
}

/** 取出某站点已保存的自定义请求头（解不开就当作没有）。 */
function siteHeaders(site) {
  if (!site || !site.headers) return null;
  try {
    const { headers } = parseHeaders(unseal(site.headers));
    return Object.keys(headers).length ? headers : null;
  } catch {
    return null;
  }
}

function resolveTarget(site, p) {
  const raw = String(p || '').trim();
  if (!raw) return site.url;

  // 一律先解析成绝对地址，再校验域名。
  // 只判断「是否以 http(s):// 开头」是不够的：`//other.host/path` 是协议相对地址，
  // 会被 new URL(raw, site.url) 解析成别的域名，那样 cookie 和请求头就发出去了。
  let resolved;
  try {
    resolved = new URL(raw, site.url).toString();
  } catch {
    throw Object.assign(new Error('路径格式不正确'), { status: 400 });
  }

  if (!sameTarget(resolved, site.url)) {
    throw Object.assign(new Error(
      '只能访问这个常驻站本身：主机名和端口必须完全一致，https 站点不接受 http 地址'
    ), { status: 400 });
  }
  if (!/^https?:$/i.test(new URL(resolved).protocol)) {
    throw Object.assign(new Error('只支持 http 和 https'), { status: 400 });
  }
  return resolved;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  // 浏览器扩展（chrome-extension:// 来源）直接调接口时放行跨域；
  // 普通网页来源一律不加 CORS 头，避免被别人的页面调用。
  const origin = String(req.headers.origin || '');
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-token, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204);
    return res.end();
  }

  // ---- 静态页面（管理界面优先走浏览器扩展；这里可关）----
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (!SERVE_WEB) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('这个服务只提供接口，管理界面在浏览器扩展里。\n');
    }
    const f = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(f)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('这个服务没有附带网页前端，请用浏览器扩展管理。\n');
    }
    const buf = fs.readFileSync(f);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    return res.end(buf);
  }

  // ---- 接口 ----
  if (!pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  if (pathname === '/api/health') {
    return send(res, 200, { ok: true, version: VERSION, sites: sites.length, authed: tokenOk(req) });
  }

  // 公开的汇总数字（只给计数，不含网址/cookie），供首页卡片显示
  if (pathname === '/api/summary') {
    const st = (s) => s.last?.status || 'unknown';
    const cnt = (fn) => sites.filter((s) => fn(st(s))).length;
    return send(res, 200, {
      total: sites.length,
      valid: cnt((x) => x === 'valid'),
      invalid: cnt((x) => x === 'expired' || x === 'invalid'),
      unreachable: cnt((x) => x === 'unreachable'),
      unknown: cnt((x) => x === 'unknown' || x === 'checking'),
    });
  }

  if (!tokenOk(req)) {
    return send(res, 401, { error: '未授权：请在页面填入 token，或加 Authorization: Bearer <token>' });
  }

  const m = pathname.match(/^\/api\/sites\/([^/]+)(\/[a-z]+)?$/);

  // ---- GitHub OAuth 设备码登录（需要页面 token 鉴权）----
  if (pathname === '/api/oauth/config' && method === 'GET') {
    return send(res, 200, { clientId: oauthCfg.clientId || '' });
  }

  if (pathname === '/api/oauth/config' && method === 'POST') {
    const { clientId } = await readJson(req);
    const v = String(clientId || '').trim();
    if (!/^[A-Za-z0-9._-]{10,64}$/.test(v)) {
      throw Object.assign(new Error('client ID 形态不对（通常是一串 20 位左右的十六进制字符）'), { status: 400 });
    }
    oauthCfg.clientId = v;
    saveOauthCfg();
    return send(res, 200, { ok: true, clientId: v });
  }

  if (pathname === '/api/oauth/start' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const clientId = String(body.clientId || oauthCfg.clientId || '').trim();
    if (!clientId) {
      throw Object.assign(new Error('还没有 OAuth App 的 client ID，请先在 GitHub 建一个并填到设置里'), { status: 400 });
    }
    oauthCfg.clientId = clientId;
    saveOauthCfg();

    cleanupOauth();
    let gh;
    try {
      gh = await ghPost('https://github.com/login/device/code', {
        client_id: clientId,
        scope: String(body.scope || 'read:user repo'),
      });
    } catch (e) {
      throw Object.assign(new Error('连不上 GitHub：' + (e.message || e)), { status: 502 });
    }
    if (!gh.device_code || !gh.user_code) {
      const msg = gh.error_description || gh.error || 'GitHub 没有返回设备码，检查 client ID 是否正确、是否开启了 Device Flow';
      throw Object.assign(new Error(msg), { status: 400 });
    }

    const id = randomId();
    oauthSessions.set(id, {
      clientId,
      deviceCode: gh.device_code,
      interval: Number(gh.interval) || 5,
      createdAt: Date.now(),
    });
    return send(res, 200, {
      id,
      userCode: gh.user_code,
      verificationUri: gh.verification_uri || 'https://github.com/login/device',
      expiresIn: Number(gh.expires_in) || 900,
      interval: Number(gh.interval) || 5,
    });
  }

  if (pathname === '/api/oauth/poll' && method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const sess = oauthSessions.get(id);
    if (!sess) return send(res, 404, { status: 'error', error: '登录会话不存在或已过期，请重新发起' });

    let gh;
    try {
      gh = await ghPost('https://github.com/login/oauth/access_token', {
        client_id: sess.clientId,
        device_code: sess.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch (e) {
      return send(res, 200, { status: 'pending', note: '网络抖动，稍后重试' });
    }

    if (gh.access_token) {
      oauthSessions.delete(id);
      return send(res, 200, { status: 'ok', token: gh.access_token, scope: gh.scope || '' });
    }

    const err = gh.error || '';
    if (err === 'authorization_pending') return send(res, 200, { status: 'pending' });
    if (err === 'slow_down') {
      sess.interval += 5;
      return send(res, 200, { status: 'pending', interval: sess.interval });
    }
    oauthSessions.delete(id);
    const desc = err === 'expired_token' ? '设备码已过期，请重新发起'
      : err === 'access_denied' ? '你在 GitHub 页面拒绝了授权'
        : (gh.error_description || err || '未知错误');
    return send(res, 200, { status: 'error', error: err, message: desc });
  }

  if (pathname === '/api/sites' && method === 'GET') {
    return send(res, 200, { sites: sites.map((s) => publicView(s)) });
  }

  if (pathname === '/api/sites' && method === 'POST') {
    const input = await readJson(req);
    const v = validateSiteInput(input);
    v.cookie = finalizeCookie(v.cookie, v.url);   // 兼容「表格」形式的粘贴
    if (!v.cookie && !v.headers) {
      // 只要有一种凭据就能跑：cookie（网页会话）或 额外请求头（如 Bearer token）
      throw Object.assign(new Error('需要填入登录 Cookie，或至少一个额外请求头（例如 Authorization: Bearer xxx）'), { status: 400 });
    }
    const site = {
      id: randomId(),
      name: v.name || (() => { try { return new URL(v.url).hostname; } catch { return '未命名'; } })(),
      url: v.url,
      cookie: seal(v.cookie),
      headers: seal(v.headers || ''),
      ua: v.ua || '',
      expect: v.expect || '',
      intervalMin: v.intervalMin,
      enabled: true,
      createdAt: new Date().toISOString(),
      last: { status: 'unknown' },
    };
    sites.push(site);
    await save();
    checkSite(site).catch(() => {});
    return send(res, 201, { site: publicView(site) });
  }

  if (m) {
    const site = findSite(m[1]);
    if (!site) return send(res, 404, { error: '没有这个常驻站' });
    const sub = m[2] || '';

    if (sub === '' && method === 'GET') {
      const reveal = url.searchParams.get('reveal') === '1';
      return send(res, 200, { site: publicView(site, { reveal }) });
    }

    if (sub === '' && (method === 'PATCH' || method === 'PUT')) {
      const input = await readJson(req);
      const v = validateSiteInput(input, { partial: true });
      if (v.name !== undefined) site.name = v.name || site.name;
      if (v.url !== undefined) site.url = v.url;
      if (v.cookie !== undefined) site.cookie = seal(finalizeCookie(v.cookie, v.url || site.url));
      if (v.headers !== undefined) site.headers = seal(v.headers);
      if (v.ua !== undefined) site.ua = v.ua;
      if (v.expect !== undefined) site.expect = v.expect;
      if (v.intervalMin !== undefined) site.intervalMin = v.intervalMin;
      if (v.enabled !== undefined) site.enabled = v.enabled;
      if (v.url !== undefined) site.last = { status: 'unknown' };
      await save();
      if (v.url !== undefined || v.cookie !== undefined) checkSite(site).catch(() => {});
      return send(res, 200, { site: publicView(site) });
    }

    if (sub === '' && method === 'DELETE') {
      sites = sites.filter((s) => s.id !== site.id);
      await save();
      return send(res, 200, { ok: true });
    }

    if (sub === '/check' && (method === 'POST' || method === 'GET')) {
      const last = await checkSite(site, { force: true });
      return send(res, 200, { site: publicView(site), last });
    }

    // 带 cookie 取内容：人工/AI 都能用
    if (sub === '/fetch' && (method === 'GET' || method === 'POST')) {
      let p, m2 = 'GET', body, contentType, cap;
      if (method === 'GET') {
        p = url.searchParams.get('path') || url.searchParams.get('url') || '';
        m2 = (url.searchParams.get('method') || 'GET').toUpperCase();
        body = url.searchParams.get('body') || undefined;
        contentType = url.searchParams.get('contentType') || undefined;
        cap = Number(url.searchParams.get('max')) || FETCH_DEFAULT_CAP;
      } else {
        const j = await readJson(req);
        p = j.path || j.url || '';
        m2 = String(j.method || 'GET').toUpperCase();
        body = j.body;
        contentType = j.contentType;
        cap = Number(j.max) || FETCH_DEFAULT_CAP;
      }
      cap = Math.max(1024, Math.min(FETCH_MAX_CAP, cap));

      const target = resolveTarget(site, p);
      let cookie = '';
      try { cookie = unseal(site.cookie); } catch { /* 空 cookie 也允许 */ }

      try {
        const r = await requestFollow(target, {
          cookie,
          ua: site.ua,
          extraHeaders: siteHeaders(site),
          method: m2,
          body,
          contentType,
          cap,
        });
        const ct = String(r.res.headers.get('content-type') || '');
        const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(ct) || ct === '';
        const payload = {
          url: r.finalUrl,
          requested: target,
          status: r.res.status,
          contentType: ct,
          size: r.buf ? r.buf.length : 0,
          truncated: Boolean(r.truncated),
          redirects: r.chain,
          crossOrigin: r.crossOrigin || undefined,
        };
        const disp = r.res.headers?.get?.('content-disposition');
        if (disp) payload.contentDisposition = disp;
        if (isText) {
          payload.text = r.buf ? r.buf.toString('utf8') : '';
        } else {
          payload.bodyBase64 = r.buf ? r.buf.toString('base64') : '';
        }
        return send(res, 200, payload);
      } catch (e) {
        const { timeout, code, detail } = describeFetchError(e);
        const msg = timeout ? '超时' : (code ? `${code}（${detail}）` : detail);
        return send(res, 502, { error: `抓取失败：${msg}`, url: target });
      }
    }
  }

  return send(res, 404, { error: '未知接口' });
}

// ---------------------------------------------------------------- 启动

load();
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) log('处理请求出错：', req.method, req.url, e.message);
    try { send(res, status, { error: e.message || '服务器内部错误' }); } catch { /* 已发送 */ }
  });
});

server.listen(PORT, HOST, () => {
  log(`网站常驻服务已启动 http://${HOST}:${PORT}  (${sites.length} 个常驻站)`);
  scheduleLoop();
});

const shutdown = (sig) => {
  log('收到信号，退出：', sig);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
