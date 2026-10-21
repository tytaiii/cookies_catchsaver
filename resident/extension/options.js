'use strict';

/**
 * 网站常驻 · 管理面板
 * 原先放在服务器上的网页前端，现在搬到这里。
 * 服务端只提供接口，不再需要 /resident/ 这个页面。
 */

const $ = (id) => document.getElementById(id);

const state = {
  base: '',
  token: '',
  sites: [],
  editingId: null,
  revealId: null,
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

const STATUS = {
  valid: { text: '有效', cls: 'ok' },
  expired: { text: '登录失效', cls: 'bad' },
  invalid: { text: '网址失效', cls: 'bad' },
  unreachable: { text: '打不开', cls: 'warn' },
  unknown: { text: '未检测', cls: '' },
  checking: { text: '检测中', cls: '' },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function relTime(iso) {
  if (!iso) return '未检测';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '未检测';
  const d = Math.max(0, Date.now() - t);
  if (d < 60e3) return '刚刚';
  if (d < 36e5) return Math.round(d / 60e3) + ' 分钟前';
  if (d < 864e5) return Math.round(d / 36e5) + ' 小时前';
  return Math.round(d / 864e5) + ' 天前';
}

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + u[i];
}

function msg(el, text, kind) {
  const node = typeof el === 'string' ? $(el) : el;
  node.textContent = text || '';
  node.className = 'msg' + (kind ? ' ' + kind : '');
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  headers['X-Token'] = state.token;
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(state.base + path, Object.assign({}, options, { headers }));
  let data = {};
  try { data = await res.json(); } catch { /* 忽略 */ }
  if (res.status === 401) throw new Error('授权码无效，请在连接设置里重新获取');
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------------- 连接 ---------------- */

async function loadSettings() {
  const s = await chrome.storage.local.get(['base', 'token']);
  if (s.base) state.base = s.base;
  if (s.token) state.token = s.token;
  $('s-base').value = state.base;
  $('s-token').value = state.token;
}

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
    } catch { /* 跳过 */ }
  }
  return null;
}

async function autoConnect(quiet) {
  try {
    state.base = normalizeBase($('s-base').value || state.base);
  } catch (e) {
    if (!quiet) msg('conn', e.message, 'err');
    return false;
  }
  const found = await findTokenFromTabs();
  if (!found) {
    if (!quiet) msg('conn', '没找到已登录的页面，请手动填写授权码', 'err');
    return false;
  }
  state.token = found.token;
  await chrome.storage.local.set({ base: state.base, token: state.token });
  $('s-base').value = state.base;
  $('s-token').value = state.token;
  return true;
}

function setConn(text, ok) {
  const el = $('conn');
  el.className = 'conn' + (ok ? '' : ' bad');
  el.innerHTML = text;
}

/* ---------------- 列表 ---------------- */

function cardHtml(site) {
  const st = STATUS[(site.last && site.last.status) || 'unknown'] || STATUS.unknown;
  const last = site.last || {};
  const cls = st.cls === 'bad' ? 'bad' : (st.cls === 'warn' ? 'warn' : '');
  const reason = last.reason
    ? `<div class="site-reason ${st.cls === 'bad' ? 'err' : ''}">${esc(last.reason)}${
      last.httpStatus ? ` <span style="color:var(--dim)">· HTTP ${last.httpStatus} · ${last.ms || 0}ms</span>` : ''
    }</div>`
    : '';
  const title = last.title ? `<div class="site-reason" style="color:var(--dim)">页面标题：${esc(last.title)}</div>` : '';
  const reveal = state.revealId === site.id
    ? `<pre id="reveal-${esc(site.id)}">读取中…</pre>`
    : '';

  return `
  <div class="site ${cls}" data-id="${esc(site.id)}">
    <div class="site-head">
      <span class="dot ${st.cls}"></span>
      <span class="site-name">${esc(site.name)}</span>
      <span class="tag ${st.cls}">${st.text}</span>
      <span class="site-meta">${esc(relTime(last.at))}检测 · 每 ${site.intervalMin} 分钟</span>
    </div>
    <div class="site-url">${esc(site.url)}</div>
    ${reason}${title}${reveal}
    <div class="site-actions">
      <button class="ghost sm" data-act="check" data-id="${esc(site.id)}">检测</button>
      <button class="ghost sm" data-act="edit" data-id="${esc(site.id)}">编辑</button>
      <button class="ghost sm" data-act="reveal" data-id="${esc(site.id)}">${
        state.revealId === site.id ? '收起凭据' : '查看凭据'
      }</button>
      <button class="ghost sm danger" data-act="del" data-id="${esc(site.id)}">删除</button>
    </div>
  </div>`;
}

function render() {
  const list = $('list');
  if (!state.sites.length) {
    list.innerHTML = '<div class="empty">还没有常驻站。<br>点上面的「新建常驻站」，或者在网页上用扩展一键添加。</div>';
    return;
  }
  list.innerHTML = state.sites.map(cardHtml).join('');
  const ok = state.sites.filter((s) => (s.last || {}).status === 'valid').length;
  const bad = state.sites.filter((s) => ['expired', 'invalid'].includes((s.last || {}).status)).length;
  setConn(`已连接 · ${esc(state.base)} · ${state.sites.length} 个站点，有效 ${ok}${bad ? `，失效 ${bad}` : ''}`, true);
}

async function loadSites() {
  const d = await api('/api/sites');
  state.sites = d.sites || [];
  render();
}

/* ---------------- 表单 ---------------- */

function resetForm() {
  state.editingId = null;
  $('form-title').textContent = '新建常驻站';
  $('f-name').value = '';
  $('f-url').value = '';
  $('f-cookie').value = '';
  $('f-headers').value = '';
  $('f-expect').value = '';
  $('f-ua').value = '';
  $('f-interval').value = '30';
  msg('form-msg', '');
}

function openForm(site) {
  resetForm();
  if (site) {
    state.editingId = site.id;
    $('form-title').textContent = '编辑：' + site.name;
    $('f-name').value = site.name || '';
    $('f-url').value = site.url || '';
    $('f-expect').value = site.expect || '';
    $('f-interval').value = site.intervalMin || 30;
    msg('form-msg', '正在读取已保存的凭据…');
    api('/api/sites/' + encodeURIComponent(site.id) + '?reveal=1').then((d) => {
      $('f-cookie').value = d.site.cookie || '';
      $('f-headers').value = d.site.headers || '';
      $('f-ua').value = d.site.ua || '';
      msg('form-msg', '');
    }).catch((e) => msg('form-msg', '读取凭据失败：' + e.message, 'err'));
  }
  $('form').hidden = false;
  $('form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('f-url').focus();
}

async function saveForm() {
  const payload = {
    name: $('f-name').value.trim(),
    url: $('f-url').value.trim(),
    cookie: $('f-cookie').value.trim(),
    headers: $('f-headers').value.trim(),
    expect: $('f-expect').value.trim(),
    ua: $('f-ua').value.trim(),
    intervalMin: Number($('f-interval').value) || 30,
  };
  if (!payload.url) return msg('form-msg', '网址不能为空', 'err');
  if (!state.editingId && !payload.cookie && !payload.headers) {
    return msg('form-msg', '至少要有 Cookie 或额外请求头', 'err');
  }

  const btn = $('f-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    if (state.editingId) {
      if (!payload.cookie) delete payload.cookie;
      if (!payload.headers) delete payload.headers;
      await api('/api/sites/' + encodeURIComponent(state.editingId), {
        method: 'PATCH', body: JSON.stringify(payload),
      });
    } else {
      await api('/api/sites', { method: 'POST', body: JSON.stringify(payload) });
    }
    $('form').hidden = true;
    resetForm();
    await loadSites();
    msg('form-msg', '已保存，正在检测…', 'ok');
  } catch (e) {
    msg('form-msg', e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并检测';
  }
}

/* ---------------- 动作 ---------------- */

async function doAction(act, id) {
  const site = state.sites.find((s) => s.id === id);
  if (!site) return;

  if (act === 'edit') return openForm(site);

  if (act === 'del') {
    if (!confirm(`确定删除「${site.name}」？cookie 和请求头会一起删掉。`)) return;
    await api('/api/sites/' + encodeURIComponent(id), { method: 'DELETE' });
    if (state.revealId === id) state.revealId = null;
    return loadSites();
  }

  if (act === 'check') {
    site.last = { status: 'checking' };
    render();
    try {
      await api('/api/sites/' + encodeURIComponent(id) + '/check', { method: 'POST' });
    } catch (e) {
      alert('检测失败：' + e.message);
    }
    return loadSites();
  }

  if (act === 'reveal') {
    if (state.revealId === id) {
      state.revealId = null;
      return render();
    }
    state.revealId = id;
    render();
    try {
      const d = await api('/api/sites/' + encodeURIComponent(id) + '?reveal=1');
      const el = document.getElementById('reveal-' + id);
      if (!el) return;
      const parts = [];
      parts.push('Cookie:\n' + (d.site.cookie || '（空）'));
      parts.push('\n额外请求头:\n' + (d.site.headers || '（空）'));
      parts.push('\nUser-Agent:\n' + (d.site.ua || '（默认）'));
      el.textContent = parts.join('\n');
    } catch (e) {
      const el = document.getElementById('reveal-' + id);
      if (el) el.textContent = '读取失败：' + e.message;
    }
  }
}

/* ---------------- 启动 ---------------- */

(async function init() {
  await loadSettings();

  $('new-btn').addEventListener('click', () => openForm(null));
  $('reload-btn').addEventListener('click', () => {
    loadSites().catch((e) => setConn('刷新失败：' + esc(e.message), false));
  });
  $('settings-btn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  $('s-save').addEventListener('click', async () => {
    try {
      state.base = normalizeBase($('s-base').value);
      state.token = $('s-token').value.trim();
      await chrome.storage.local.set({ base: state.base, token: state.token });
      $('s-base').value = state.base;
      if (!state.token) return setConn('地址已保存。登录服务页面后点「自动获取」。', false);
      await loadSites();
    } catch (e) { setConn('设置或连接失败：' + esc(e.message), false); }
  });
  $('s-auto').addEventListener('click', async () => {
    const ok = await autoConnect(false);
    if (ok) {
      try { await loadSites(); } catch (e) { setConn('连接失败：' + esc(e.message), false); }
    }
  });
  $('f-save').addEventListener('click', saveForm);
  $('f-cancel').addEventListener('click', () => { $('form').hidden = true; resetForm(); });

  $('list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    doAction(btn.dataset.act, btn.dataset.id).catch((err) => alert(err.message));
  });

  setConn('正在连接 <b>…</b>', true);
  if (!state.base) {
    setConn('未连接 · 请先填写自己的服务地址', false);
    $('settings').hidden = false;
    return;
  }
  if (!state.token) {
    const ok = await autoConnect(true);
    if (!ok) {
      setConn('未连接 · 请点右上角「连接设置」填写服务地址和授权码', false);
      $('settings').hidden = false;
      return;
    }
  }
  try {
    await loadSites();
  } catch (e) {
    setConn('连接失败：' + esc(e.message), false);
    $('settings').hidden = false;
  }
})();
