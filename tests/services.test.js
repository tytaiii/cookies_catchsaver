'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'integration-test-token';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
}

async function startService(t, service, env = {}, setup = async () => {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catchsaver-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.join(ROOT, service, 'server.js'), path.join(dir, 'server.js'));
  await fs.mkdir(path.join(dir, 'data'));
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/index.html'), '<title>{{SITE}}</title>');
  await fs.writeFile(path.join(dir, 'data/token.txt'), TOKEN);
  const extraArgs = await setup(dir) || [];
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [...extraArgs, path.join(dir, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SPACE_ROOT: path.join(dir, 'files'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const health = service === 'resident' ? '/api/health' : '/health';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error(output);
    try {
      const response = await fetch(base + health, { signal: AbortSignal.timeout(200) });
      if (response.ok) return { base, dir, output: () => output };
    } catch { /* Wait for the listener. */ }
    await delay(25);
  }
  throw new Error('Service did not start: ' + output);
}

function api(base, route, options = {}) {
  return fetch(base + route, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-token': TOKEN, ...options.headers },
  });
}

async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for the expected state');
}

test('Resident renews cookies across redirects and persists browser identity without leaking credentials', async (t) => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === '/start') {
      res.writeHead(302, {
        location: '/account',
        'set-cookie': [
          'session=rotated; Path=/',
          'removed=; Max-Age=0; Path=/',
          'keep=new; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
          'empty=; Path=/',
          'foreign=blocked; Domain=other.example.test',
        ],
      });
    } else {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': req.url === '/refresh' ? 'session=fetched; Path=/' : 'final=ok; Path=/' });
    }
    res.end('signed in');
  });
  const port = await listen(t, upstream);
  const { base, dir, output } = await startService(t, 'resident');
  const created = await api(base, '/api/sites', { method: 'POST', body: JSON.stringify({
    name: 'Local upstream', url: `http://127.0.0.1:${port}/start`,
    cookie: 'session=original; removed=yes; keep=old', ua: 'Catchsaver test browser',
    hints: 'sec-ch-ua-platform: "Test OS"',
  }) });
  assert.equal(created.status, 201);
  const id = (await created.json()).site.id;
  await waitFor(async () => (await (await api(base, `/api/sites/${id}`)).json()).site.last.status === 'valid');
  const follow = requests.find((r) => r.url === '/account');
  assert.match(follow.headers.cookie, /session=rotated/);
  assert.match(follow.headers.cookie, /keep=new/);
  assert.match(follow.headers.cookie, /empty=/);
  assert.doesNotMatch(follow.headers.cookie, /removed=|foreign=/);
  assert.equal(follow.headers['user-agent'], 'Catchsaver test browser');
  assert.equal(follow.headers['sec-ch-ua-platform'], '"Test OS"');
  const revealed = (await (await api(base, `/api/sites/${id}?reveal=1`)).json()).site;
  assert.match(revealed.cookie, /final=ok/);
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'data/sites.json'), 'utf8'), /session=rotated/);
  assert.doesNotMatch(output(), /session=rotated/);
  const badHints = await api(base, `/api/sites/${id}`, { method: 'PATCH', body: JSON.stringify({ hints: 'Authorization: Bearer hidden' }) });
  assert.equal(badHints.status, 400);
  const unsafe = await api(base, `/api/sites/${id}/fetch?path=${encodeURIComponent('http://127.0.0.1:1/account')}`);
  assert.equal(unsafe.status, 400);
  const fetched = await api(base, `/api/sites/${id}/fetch?path=/refresh`);
  assert.equal(fetched.status, 200);
  assert.match((await (await api(base, `/api/sites/${id}?reveal=1`)).json()).site.cookie, /session=fetched/);
});

test('Resident pins an authenticated extension and rate limits spoofed-IP attempts', async (t) => {
  const { base } = await startService(t, 'resident', { AUTH_MAX_FAILS: '2', AUTH_BLOCK_SEC: '0.1' });
  const first = 'chrome-extension://' + 'a'.repeat(32);
  const second = 'chrome-extension://' + 'b'.repeat(32);
  const rejected = await api(base, '/api/sites', { headers: { origin: second, 'x-token': 'wrong' } });
  assert.equal(rejected.status, 401);
  assert.equal((await api(base, '/api/sites', { headers: { origin: first } })).status, 200);
  const foreign = await api(base, '/api/sites', { headers: { origin: second } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  for (const fakeIp of ['192.0.2.1', '192.0.2.2']) {
    assert.equal((await api(base, '/api/sites', { headers: { 'x-token': 'wrong', 'cf-connecting-ip': fakeIp } })).status, 401);
  }
  assert.equal((await api(base, '/api/sites')).status, 429);
  await delay(150);
  assert.equal((await api(base, '/api/sites')).status, 200);
  assert.equal((await api(base, '/api/mail/test', { method: 'POST' })).status, 400);
});

test('Concurrent agent fetches reuse each newly rotated session instead of racing', async (t) => {
  let generation = 0;
  const port = await listen(t, http.createServer((req, res) => {
    if (req.headers.cookie !== `session=${generation}`) {
      res.writeHead(401); return res.end('old session');
    }
    generation++;
    const next = generation;
    setTimeout(() => {
      res.writeHead(200, { 'set-cookie': `session=${next}; Path=/` });
      res.end('signed in');
    }, 40);
  }));
  const { base } = await startService(t, 'resident');
  const created = await api(base, '/api/sites', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${port}/`, cookie: 'session=0' }) });
  const id = (await created.json()).site.id;
  await waitFor(async () => (await (await api(base, `/api/sites/${id}`)).json()).site.last.status === 'valid');
  const results = await Promise.all([1, 2].map(async () => (await api(base, `/api/sites/${id}/fetch`)).json()));
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await (await api(base, `/api/sites/${id}?reveal=1`)).json()).site.cookie, `session=${generation}`);
});

test('A new cookie survives failure of a later redirect hop', async (t) => {
  const port = await listen(t, http.createServer((req, res) => {
    if (req.url === '/renew') {
      res.writeHead(302, { location: '/broken', 'set-cookie': 'session=renewed; Path=/' });
      res.end();
    } else if (req.url === '/broken') req.socket.destroy();
    else res.end('signed in');
  }));
  const { base } = await startService(t, 'resident');
  const created = await api(base, '/api/sites', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${port}/`, cookie: 'session=old' }) });
  const id = (await created.json()).site.id;
  await waitFor(async () => (await (await api(base, `/api/sites/${id}`)).json()).site.last.status === 'valid');
  assert.equal((await api(base, `/api/sites/${id}/fetch?path=/renew`)).status, 502);
  assert.equal((await (await api(base, `/api/sites/${id}?reveal=1`)).json()).site.cookie, 'session=renewed');
});

test('An in-flight request cannot overwrite cookies manually replaced in the extension', async (t) => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  t.after(finish);
  const port = await listen(t, http.createServer(async (req, res) => {
    if (req.url === '/slow') {
      release(); await gate;
      res.setHeader('set-cookie', 'session=stale-rotation; Path=/');
    }
    res.end('signed in');
  }));
  const { base } = await startService(t, 'resident');
  const created = await api(base, '/api/sites', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${port}/`, cookie: 'session=old' }) });
  const id = (await created.json()).site.id;
  await waitFor(async () => (await (await api(base, `/api/sites/${id}`)).json()).site.last.status === 'valid');
  const fetching = api(base, `/api/sites/${id}/fetch?path=/slow`);
  await started;
  assert.equal((await api(base, `/api/sites/${id}`, { method: 'PATCH', body: JSON.stringify({ cookie: 'session=manual-new' }) })).status, 200);
  finish(); await fetching;
  assert.equal((await (await api(base, `/api/sites/${id}?reveal=1`)).json()).site.cookie, 'session=manual-new');
});

test('Resident expires tokens and resets their age when a token is regenerated', async (t) => {
  const old = await startService(t, 'resident', { TOKEN_MAX_AGE_DAYS: '1' }, async (dir) => {
    await fs.writeFile(path.join(dir, 'data/token.meta.json'), JSON.stringify({ createdAt: Date.now() - 2 * 86400000 }));
  });
  assert.equal((await api(old.base, '/api/sites')).status, 401);
  assert.equal((await (await api(old.base, '/api/health')).json()).authed, false);
  const fresh = await startService(t, 'resident', { TOKEN_MAX_AGE_DAYS: '1' }, async (dir) => {
    await fs.unlink(path.join(dir, 'data/token.txt'));
    await fs.writeFile(path.join(dir, 'data/token.meta.json'), JSON.stringify({ createdAt: Date.now() - 2 * 86400000 }));
  });
  const newToken = (await fs.readFile(path.join(fresh.dir, 'data/token.txt'), 'utf8')).trim();
  assert.equal((await api(fresh.base, '/api/sites', { headers: { 'x-token': newToken } })).status, 200);
});

test('Space protects listing, downloads and deletion and removes bootstrap tokens from URLs', async (t) => {
  const { base, dir } = await startService(t, 'space', { SPACE_TOKEN: 'space-test-token' }, async (dir) => {
    await fs.mkdir(path.join(dir, 'files'));
    await fs.writeFile(path.join(dir, 'files/example.txt'), 'test file');
  });
  for (const route of ['/', '/api/list', '/api/summary', '/f?p=example.txt']) {
    assert.equal((await fetch(base + route)).status, 401);
  }
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/f?p=example.txt', { method: 'DELETE' })).status, 401);
  const login = await fetch(base + '/?token=space-test-token&p=', { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '?p=');
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(login.headers.get('location'), /space-test-token/);
  const auth = { cookie: cookie.split(';')[0] };
  assert.equal(await (await fetch(base + '/f?p=example.txt', { headers: auth })).text(), 'test file');
  assert.equal((await fetch(base + '/', { headers: { cookie: 'space_token=%invalid' } })).status, 401);
  assert.equal((await fetch(base + '/f?p=example.txt', { method: 'DELETE', headers: auth })).status, 200);
  await assert.rejects(fs.stat(path.join(dir, 'files/example.txt')), { code: 'ENOENT' });
});

test('Space remains public when no access token is configured', async (t) => {
  const { base } = await startService(t, 'space', { SPACE_TOKEN: '' });
  assert.equal((await fetch(base + '/api/list')).status, 200);
});

test('Resident sends SMTP alerts, retries failures, throttles repeats and alerts again after recovery', async (t) => {
  const messages = [];
  let rejectNext = false;
  const smtp = net.createServer((socket) => {
    socket.write('220 test SMTP\r\n');
    let buffer = '', state = 'command', data = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (state === 'data') {
          if (line === '.') { messages.push(data.join('\r\n')); data = []; state = 'command'; socket.write('250 accepted\r\n'); }
          else data.push(line);
        } else if (state === 'user') { state = 'password'; socket.write('334 password\r\n'); }
        else if (state === 'password') { state = 'command'; socket.write('235 authenticated\r\n'); }
        else if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') { state = 'user'; socket.write('334 username\r\n'); }
        else if (line === 'DATA') {
          if (rejectNext) { rejectNext = false; socket.write('451 temporarily unavailable\r\n'); }
          else { state = 'data'; socket.write('354 send data\r\n'); }
        }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  const smtpPort = await listen(t, smtp);
  let upstreamStatus = 401;
  const port = await listen(t, http.createServer((req, res) => { res.writeHead(upstreamStatus); res.end('test'); }));
  const { base, output } = await startService(t, 'resident', {}, async (dir) => {
    await fs.writeFile(path.join(dir, 'data/mail.json'), JSON.stringify({ enabled: true, host: 'smtp.example.test', port: smtpPort, user: 'sender@example.test', pass: 'test-password', from: 'sender@example.test', to: 'receiver@example.test', minIntervalHours: 6 }));
    // Only the TLS transport is replaced; the SMTP protocol and alert logic run normally.
    const preload = path.join(dir, 'smtp-preload.cjs');
    await fs.writeFile(preload, `require('node:tls').connect = () => require('node:net').connect({ host: '127.0.0.1', port: ${smtpPort} });`);
    return ['--require', preload];
  });
  assert.equal((await (await api(base, '/api/mail/status')).json()).ready, true);
  assert.equal((await api(base, '/api/mail/test', { method: 'POST' })).status, 200);
  const created = await api(base, '/api/sites', { method: 'POST', body: JSON.stringify({ name: 'Alert test', url: `http://127.0.0.1:${port}/`, cookie: 'session=test' }) });
  const id = (await created.json()).site.id;
  await waitFor(() => messages.length === 2);
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  assert.equal(messages.length, 2);
  upstreamStatus = 200;
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  upstreamStatus = 401;
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  await waitFor(() => messages.length === 3);
  assert.match(messages[2], /Content-Transfer-Encoding: base64/);
  upstreamStatus = 200;
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  upstreamStatus = 401;
  rejectNext = true;
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  await waitFor(() => output().includes('告警邮件发送失败'));
  await api(base, `/api/sites/${id}/check`, { method: 'POST' });
  await waitFor(() => messages.length === 4);
});
