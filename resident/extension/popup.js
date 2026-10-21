'use strict';

/**
 * 常驻站 Cookie 助手
 * ------------------------------------------------------------
 * 1. 读当前标签页的域名；
 * 2. 用 chrome.cookies API 取该页面会发送的全部 cookie（含 HttpOnly）；
 * 3. 拼成 Cookie 请求头，写进选中的常驻站，并触发一次检测。
 */

const $ = (id) => document.getElementById(id);

let state = {
  base: '',
  token: '',
  tabUrl: '',
  host: '',
  sites: [],
  cookies: [],
};

function normalizeBase(raw) {
  if (!String(raw || '').trim()) throw new Error('请先填写你的服务地址');
  const u = new URL(String(raw).trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('服务地址格式不正确');
  }
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('远程服务请使用 HTTPS');
  }
  if (u.pathname.replace(/\/+$/, '') !== '/resident') {
    throw new Error('服务地址应以 /resident 结尾');
  }
  return u.origin + '/resident';
}

/* ---------------- 基础 ---------------- */

function msg(text, kind) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = kind || '';
}

function setBusy(busy) {
  $('write').disabled = busy;
  $('copy').disabled = busy;
  $('save').disabled = busy;
}

function sameSiteHost(a, b) {
  if (!a || !b) return false;
  const x = a.replace(/^www\./i, '').toLowerCase();
  const y = b.replace(/^www\./i, '').toLowerCase();
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  headers['X-Token'] = state.token;
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(state.base.replace(/\/+$/, '') + path, Object.assign({}, options, { headers }));
  let data = {};
  try { data = await res.json(); } catch { /* 忽略非 JSON */ }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------------- 读取环境 ---------------- */

async function loadSettings() {
  const s = await chrome.storage.local.get(['base', 'token']);
  if (s.base) state.base = s.base;
  if (s.token) state.token = s.token;
  $('base').value = state.base;
  $('token').value = state.token;
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    $('cur').textContent = '无法读取当前标签页';
    return;
  }
  state.tabUrl = tab.url;
  state.tabTitle = (tab.title || '').trim();
  try {
    state.host = new URL(tab.url).hostname;
  } catch {
    state.host = '';
  }
  $('cur').textContent = state.host || tab.url;
}

async function loadCookies() {
  if (!state.tabUrl || !/^https?:/i.test(state.tabUrl)) {
    state.cookies = [];
    return;
  }
  state.cookies = await chrome.cookies.getAll({ url: state.tabUrl });
}

async function loadSites() {
  if (!state.base || !state.token) return;
  const d = await api('/api/sites');
  state.sites = d.sites || [];
  const sel = $('target');
  const st = $('sites-state');
  sel.innerHTML = '';
  if (!state.sites.length) {
    sel.innerHTML = '<option value="">— 没有常驻站 —</option>';
    st.textContent = '服务里还没有任何常驻站，先去页面添加一个';
    return;
  }
  for (const s of state.sites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} · ${s.last ? s.last.status : '未检测'}`;
    let host = '';
    try { host = new URL(s.url).hostname; } catch { /* 忽略 */ }
    opt.dataset.host = host;
    sel.appendChild(opt);
  }
  // 自动选中域名匹配的那条
  const match = state.sites.find((s) => {
    try { return sameSiteHost(new URL(s.url).hostname, state.host); } catch { return false; }
  });
  if (match) {
    sel.value = match.id;
    st.textContent = `共 ${state.sites.length} 个常驻站，已自动选中域名匹配的「${match.name}」`;
  } else {
    st.textContent = `共 ${state.sites.length} 个常驻站，但没有和 ${state.host} 匹配的，请手动选一个`;
  }
}

/* ---------------- 动作 ---------------- */

function cookieHeader() {
  const now = Date.now() / 1000;
  const list = state.cookies
    .filter((c) => !c.expirationDate || c.expirationDate > now)
    .map((c) => `${c.name}=${c.value}`);
  return list.join('; ');
}

async function writeToSite() {
  const id = $('target').value;
  if (!id) {
    return msg('还没选中常驻站。先在上面填好「服务地址」和「访问令牌」，点『保存设置』，下拉框会自动加载出站点。', 'err');
  }
  const header = cookieHeader();
  if (!header) return msg('这个页面没有可取到的 cookie（可能要刷新一下再试）', 'err');

  setBusy(true);
  msg('正在写入…');
  try {
    await api('/api/sites/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ cookie: header }),
    });
    const d = await api('/api/sites/' + encodeURIComponent(id) + '/check', { method: 'POST' });
    const last = (d.site && d.site.last) || d.last || {};
    const n = state.cookies.length;
    if (last.status === 'valid') {
      msg(`✅ 已写入 ${n} 个 cookie，检测通过：${last.reason || '可访问'}`, 'ok');
    } else {
      msg(`⚠️ 已写入 ${n} 个 cookie，但检测结果：${last.status}（${last.reason || ''}）`, 'err');
    }
    await loadSites();
  } catch (e) {
    msg('写入失败：' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function createAndWrite() {
  const header = cookieHeader();
  if (!header) return msg('这个页面没有可取到的 cookie（先刷新一下页面再点）', 'err');
  if (!state.tabUrl || !/^https?:/i.test(state.tabUrl)) return msg('当前不是普通网页，无法新建', 'err');

  const btn = $('create');
  btn.disabled = true;
  msg('正在为 ' + (state.host || '当前网站') + ' 新建常驻站…');
  try {
    // 名字优先用标签页标题（去掉尾巴），太长就退回域名
    let name = state.tabTitle.replace(/\s*[-–—|]\s*.*$/, '').trim();
    if (!name || name.length > 40) name = state.host;
    const created = await api('/api/sites', {
      method: 'POST',
      body: JSON.stringify({ name, url: state.tabUrl, cookie: header }),
    });
    const id = created.site && created.site.id;
    if (!id) throw new Error('服务端没有返回新站点');

    const d = await api('/api/sites/' + encodeURIComponent(id) + '/check', { method: 'POST' });
    const last = (d.site && d.site.last) || d.last || {};
    await loadSites();
    $('target').value = id;
    const n = state.cookies.length;
    if (last.status === 'valid') {
      msg(`✅ 已新建「${name}」并写入 ${n} 个 cookie，检测通过`, 'ok');
    } else {
      msg(`⚠️ 已新建「${name}」并写入 ${n} 个 cookie，但检测结果：${last.status}（${last.reason || ''}）`, 'err');
    }
  } catch (e) {
    msg('新建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function copyOnly() {
  const header = cookieHeader();
  if (!header) return msg('这个页面没有可取到的 cookie', 'err');
  try {
    await navigator.clipboard.writeText(header);
    msg(`已复制 ${state.cookies.length} 个 cookie 到剪贴板，可以粘到常驻站页面里`, 'ok');
  } catch (e) {
    msg('复制失败：' + e.message, 'err');
  }
}

/**
 * 自动连接：从本浏览器里已登录的 /resident/ 页面读取授权码。
 * 用户不需要知道「令牌」是什么，登录过一次页面就够了。
 */
async function findTokenFromTabs() {
  const expected = new URL(state.base);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url) continue;
    let u;
    try { u = new URL(t.url); } catch { continue; }
    if (u.origin !== expected.origin || !/^\/resident(?:\/|$)/.test(u.pathname)) continue;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => window.localStorage.getItem('resident.token'),
      });
      if (res && res.result) return { token: res.result, origin: u.origin };
    } catch { /* 注入被拒就跳过这个标签页 */ }
  }
  return null;
}

async function autoConnect(openIfMissing) {
  const btn = $('auto');
  btn.disabled = true;
  msg('正在查找已登录的常驻站页面…');
  try {
    state.base = normalizeBase($('base').value || state.base);
    const found = await findTokenFromTabs();
    if (!found) {
      if (openIfMissing) {
        msg('没找到已登录的页面。已经帮你打开，登录后回到这里再点一次「自动连接」。', 'err');
        await chrome.tabs.create({ url: state.base + '/' });
      } else {
        msg('还没连接。先填服务地址，在该服务页面登录，再点「自动连接」。', 'err');
      }
      return false;
    }
    state.token = found.token;
    $('base').value = state.base;
    $('token').value = state.token;
    await chrome.storage.local.set({ base: state.base, token: state.token });
    await loadSites();
    msg('已自动连接 · 共 ' + state.sites.length + ' 个常驻站', 'ok');
    $('auto-hint').textContent = '已连接：' + state.base;
    return true;
  } catch (e) {
    msg('自动连接失败：' + e.message, 'err');
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  try {
    state.base = normalizeBase($('base').value);
    state.token = $('token').value.trim();
    await chrome.storage.local.set({ base: state.base, token: state.token });
    msg('设置已保存');
    if (!state.token) return msg('服务地址已保存。登录服务页面后点「自动连接」。');
    await loadSites();
    if (state.sites.length) msg('设置已保存，已加载 ' + state.sites.length + ' 个常驻站', 'ok');
    else msg('设置已保存，但还没有任何常驻站', 'err');
  } catch (e) {
    msg('设置或连接失败：' + e.message, 'err');
  }
}

/* ---------------- 启动 ---------------- */

(async function init() {
  $('save').addEventListener('click', saveSettings);
  $('auto').addEventListener('click', () => autoConnect(true));
  $('write').addEventListener('click', writeToSite);
  $('copy').addEventListener('click', copyOnly);
  $('create').addEventListener('click', createAndWrite);
  $('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('reload').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await loadSites();
      msg('列表已刷新');
    } catch (err) {
      msg('刷新失败：' + err.message, 'err');
    }
  });

  await loadSettings();
  await loadTab();
  await loadCookies();

  if (state.cookies.length) {
    msg(`这个页面有 ${state.cookies.length} 个 cookie 可写`);
  } else {
    msg('这个页面没有 cookie。如果刚登录过，刷新一下再点开插件');
  }

  if (!state.base) {
    $('settings').open = true;
    msg('先在高级设置中填写你的服务地址，保存后再自动连接。');
    return;
  }
  if (!state.token) {
    const ok = await autoConnect(false);
    if (!ok) return;
  }
  try {
    await loadSites();
  } catch (e) {
    msg('加载常驻站失败：' + e.message, 'err');
  }
})();
