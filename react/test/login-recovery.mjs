// Reproduces the "Completing sign-in ... never completes until I press refresh" symptom against the REAL app
// (real Electron, real site view + preload + SiteViews), using a mock login server on 127.0.0.1.
// Nobody touches Reload: the app has to get itself to the logged-in page.
//
//   s1  completion page sits idle; the approval arrives later (a plain reload finishes it)
//   s2  completion page has started a navigation to the callback that HANGS (main frame stays "loading")
//   s3  the first two reloads still show "Completing..." (approval lands a bit later)
//   s4  the login genuinely never completes: recovery must stay BOUNDED (1 load + 3 refreshes, then leave it alone)
//
// On macOS from react/: npm run build && node test/login-recovery.mjs [s1 s2 s3 s4]
// On Linux, use xvfb-run -a node test/login-recovery.mjs after building.
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarios = ['s1', 's2', 's3', 's4'];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : scenarios;
if (wanted.some((scenario) => !scenarios.includes(scenario))) throw new Error('Expected s1, s2, s3, or s4');

function mock() {
  const st = {};                         // per scenario: loads, firstAt
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (title, body = '') => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}`); };
    let m;
    if (u.pathname === '/') {
      return /ok=1/.test(req.headers.cookie ?? '') ? html('HOME-LOGGED-IN', '<h1>ChatGPT</h1>') : html('HOME-ANON', '<h1>Welcome</h1>');
    }
    if ((m = u.pathname.match(/^\/log-in\/(s\d)$/))) {
      const s = (st[m[1]] ??= { loads: 0, firstAt: Date.now(), methods: [], hangs: 0 });
      s.loads += 1;
      s.methods.push(req.method);
      const approved = m[1] === 's4' ? false : m[1] === 's3' ? s.loads >= 3 : Date.now() - s.firstAt > 3000;   // "phone approved"
      if (approved) { res.statusCode = 302; res.setHeader('location', `/api/auth/callback/${m[1]}`); return res.end(); }
      const js = m[1] === 's2' ? `<script>setTimeout(()=>{location.href='/api/auth/callback/s2?hang=1'},500)</script>` : '';
      return html(`LOGIN-${m[1]}-load${s.loads}`, `<h1>Completing sign-in…</h1>${js}`);
    }
    if ((m = u.pathname.match(/^\/api\/auth\/callback\/(s\d)$/))) {
      if (u.searchParams.get('hang') === '1') {
        st[m[1]].hangs += 1;
        return; // never answers
      }
      res.setHeader('set-cookie', 'ok=1; Path=/'); res.statusCode = 302; res.setHeader('location', '/'); return res.end();
    }
    res.statusCode = 404; res.end('nope');
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${srv.address().port}`, st,
      close: () => { for (const s of sockets) s.destroy(); srv.close(); },
    }));
  });
}

async function run(scenario) {
  const profile = await mkdtemp(path.join(tmpdir(), 'walled-login-'));
  let server;
  let app;
  const logs = [];
  try {
    server = await mock();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    app = await electron.launch({
      timeout: 20_000,
      args: ['--disable-gpu', `--user-data-dir=${profile}`, desktop],
      cwd: desktop,
      env: {
        ...env,
        WALLED_E2E: '1',
        WALLED_BACKEND_ARGS: '--no-ocr-warmup --auto-answer cancel',
        WALLED_DEBUG_NAV: '1',
        WALLED_E2E_SITES: JSON.stringify({ chatgpt: `${server.origin}/`, perplexity: `${server.origin}/` }),
      },
    });
    app.process().stdout?.on('data', (data) => logs.push(String(data)));
    app.process().stderr?.on('data', (data) => logs.push(String(data)));
    const view = (fn, arg) => app.evaluate(fn, arg);
    const info = () => view(() => {
      const wc = globalThis.__walledTest.views.all.get('chatgpt').webContents;
      return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoadingMainFrame() };
    });
    for (let i = 0; i < 100; i++) { try { if ((await info()).title === 'HOME-ANON') break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    // Land on the "Completing sign-in" page exactly as the real flow does (an auth-path document).
    await view((_e, url) => { globalThis.__walledTest.views.all.get('chatgpt').webContents.loadURL(url); }, `${server.origin}/log-in/${scenario}`);
    const t0 = Date.now();
    let last;
    if (scenario === 's4') {
      await new Promise((r) => setTimeout(r, 28_000));
      last = await info();
      const loads = server.st.s4?.loads;
      return { ok: loads === 4 && last.title === 'LOGIN-s4-load4', loads, last, logs, bounded: true };
    }
    while (Date.now() - t0 < 50_000) {
      last = await info().catch(() => last);
      if (last?.title === 'HOME-LOGGED-IN') {
        const { loads, methods, hangs } = server.st[scenario];
        const recovered = loads === (scenario === 's3' ? 3 : 2) && methods.every((method) => method === 'GET');
        const pendingMainFrame = /recovery 1\/3: .*mainFrameLoading=true/.test(logs.join(''));
        return { ok: recovered && (scenario !== 's2' || (hangs === 1 && pendingMainFrame)),
          secs: ((Date.now() - t0) / 1000).toFixed(1), loads, last, logs };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, loads: server.st[scenario]?.loads, last, logs };
  } finally {
    try {
      await app?.close();
    } finally {
      server?.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
}

let failed = 0;
for (const s of wanted) {
  const r = await run(s);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${s}  ${r.bounded ? (r.ok ? 'never approved: stopped after exactly 3 refreshes, no endless loop' : `NOT bounded: ${JSON.stringify(r.last)}`) : r.ok ? `logged in after ${r.secs}s` : `stuck on ${JSON.stringify(r.last)}`}  (server saw ${r.loads} load(s) of the completion page)`);
  if (process.env.SHOW_LOGS) console.log(r.logs.join('').split('\n').filter((l) => /\[nav\]|recover/i.test(l)).join('\n'));
  if (!r.ok) failed++;
}
process.exit(failed ? 1 : 0);
