'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function loadPanel(file, { base = '', token = 'test-token', sites = [], tabs = [], tabUrl = 'https://app.example.test:8443/page' } = {}) {
  const elements = new Map(), events = new Map(), requests = [], injected = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', dataset: {}, children: [],
      addEventListener(type, fn) { events.set(id + ':' + type, fn); },
      set innerHTML(html) { this.html = html; this.children = []; this.value = ''; },
      get innerHTML() { return this.html || ''; },
      appendChild(child) { if (!this.children.length) this.value = child.value; this.children.push(child); },
      focus() {}, scrollIntoView() {},
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    URL, console,
    document: { getElementById: element, createElement: () => ({ value: '', dataset: {} }) },
    navigator: { userAgent: 'Test browser', userAgentData: { brands: [{ brand: 'Chromium', version: '130' }], mobile: false, platform: 'Test OS' } },
    chrome: {
      storage: { local: { get: async () => ({ base, token }), set: async () => {} } },
      tabs: { query: async (options) => options.active ? [{ url: tabUrl, title: 'Test page' }] : tabs },
      scripting: { executeScript: async (options) => { injected.push(options.target.tabId); return [{ result: 'tab-token' }]; } },
      cookies: { getAll: async () => [{ name: 'session', value: 'test' }] },
      runtime: { openOptionsPage() {} },
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      return { ok: true, status: 200, json: async () => url.endsWith('/check') ? { last: { status: 'valid' } } : { sites } };
    },
  });
  await vm.runInContext(await fs.readFile(path.join(__dirname, '../resident/extension', file), 'utf8'), context);
  return { element, events, requests, injected };
}

test('Both extension panels can save and call a local service without a /resident prefix', async () => {
  for (const file of ['popup.js', 'options.js']) {
    const panel = await loadPanel(file);
    const isPopup = file === 'popup.js';
    panel.element(isPopup ? 'base' : 's-base').value = 'http://127.0.0.1:8901/';
    panel.element(isPopup ? 'token' : 's-token').value = 'test-token';
    await panel.events.get((isPopup ? 'save' : 's-save') + ':click')();
    assert.equal(panel.requests.at(-1).url, 'http://127.0.0.1:8901/api/sites');
  }
});

test('Auto connect reads tokens only from the configured service page at its configured origin', async () => {
  for (const file of ['popup.js', 'options.js']) {
    const panel = await loadPanel(file, {
      base: 'http://127.0.0.1:8901', token: '',
      tabs: [
        { id: 1, url: 'http://other.example.test/' },
        { id: 2, url: 'http://127.0.0.1:8901/other-app' },
        { id: 3, url: 'http://127.0.0.1:8901/' },
      ],
    });
    assert.deepEqual(panel.injected, [3]);
    assert.equal(panel.requests.at(-1).headers['X-Token'], 'tab-token');
  }
});

test('Popup auto-selects only an exact origin and writes browser identity along with cookies', async () => {
  const sites = [
    { id: 'parent', name: 'Parent', url: 'https://example.test/' },
    { id: 'port', name: 'Other port', url: 'https://app.example.test/' },
    { id: 'http', name: 'HTTP', url: 'http://app.example.test:8443/' },
  ];
  const unmatched = await loadPanel('popup.js', { base: 'https://resident.example.test/resident', sites });
  assert.equal(unmatched.element('target').value, '');
  sites.push({ id: 'exact', name: 'Same origin', url: 'https://app.example.test:8443/account' });
  const panel = await loadPanel('popup.js', { base: 'https://resident.example.test/resident', sites });
  assert.equal(panel.element('target').value, 'exact');
  await panel.events.get('write:click')();
  const request = panel.requests.find((r) => r.method === 'PATCH');
  const body = JSON.parse(request.body);
  assert.equal(body.cookie, 'session=test');
  assert.equal(body.ua, 'Test browser');
  assert.match(body.hints, /sec-ch-ua-platform: "Test OS"/);
});
