// codex-bridge/admin-ui.mjs
//
// Local configuration & status UI for the one-click distributable. Served on a
// SEPARATE loopback-only port (never behind the public TLS proxy), so editing
// security-relevant settings (API key, repos, sandbox) can't be reached from the
// network. Zero npm dependencies — a single self-contained HTML page + a tiny
// JSON API.
//
// Hardening (the admin API can set sandbox=dangerFullAccess === RCE):
//   • bound to 127.0.0.1 only
//   • Host header must be a loopback literal  -> defeats DNS-rebinding
//   • mutations require the `x-codex-bridge-admin` header -> defeats CSRF from a
//     malicious page in the user's browser (a cross-site fetch with a custom
//     header triggers a CORS preflight we never approve)
//   • optional CODEX_BRIDGE_ADMIN_TOKEN -> bearer required on every /api/* call

import http from 'node:http'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { CONFIG_KEYS } from './config.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostIsLoopback(hostHeader, port) {
  if (!hostHeader) return false
  const host = hostHeader.replace(/:\d+$/, '')
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`${host}`)
}

function mask(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 4) return '•'.repeat(s.length)
  return '•'.repeat(Math.max(4, s.length - 4)) + s.slice(-4)
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * List the sub-directories of `rawPath` so the GUI can offer a server-side folder
 * picker (a browser can't hand us an absolute path). Directories only; falls back
 * to the home directory for empty / missing / non-directory inputs.
 */
function listDir(rawPath) {
  let dir = rawPath && rawPath.trim() ? rawPath.trim() : homedir()
  try {
    if (!existsSync(dir)) dir = homedir()
    else if (!statSync(dir).isDirectory()) dir = dirname(dir)
  } catch {
    dir = homedir()
  }
  let entries = []
  let error = null
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => {
        try {
          return d.isDirectory() || (d.isSymbolicLink() && statSync(join(dir, d.name)).isDirectory())
        } catch {
          return false
        }
      })
      .map((d) => ({ name: d.name, path: join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    error = e.message
  }
  const parent = dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, home: homedir(), entries, error }
}

/** Build the field descriptors the page renders (secrets masked). */
function describe(config) {
  const values = config.values
  return CONFIG_KEYS.map((key) => {
    const secret = config.isSecret(key)
    return {
      key,
      value: secret ? mask(values[key]) : values[key],
      secret,
      envOverridden: config.isEnvOverridden(key),
      needsRestart: config.needsRestart(key),
      set: secret ? Boolean(values[key]) : undefined,
    }
  })
}

/**
 * Create the admin HTTP server.
 * @param {{ config: import('./config.mjs').Config, getStatus: () => object, logRequest?: (server: string, req: any, res: any, startedAt: number) => void }} deps
 */
export function createAdminServer({ config, getStatus, getLogs, logRequest }) {
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    if (logRequest) res.on('finish', () => { try { logRequest('admin', req, res, t0) } catch {} })
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const path = url.pathname
      const method = req.method || 'GET'
      const adminToken = config.values.adminToken

      // DNS-rebinding guard: the Host header must be a loopback literal.
      if (!hostIsLoopback(req.headers.host)) {
        return send(res, 403, { error: { message: 'admin UI is loopback-only' } })
      }

      // Page (GET /) is always served; API + mutations are guarded below.
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(PAGE)
      }

      if (!path.startsWith('/api/')) return send(res, 404, { error: { message: 'not found' } })

      // Optional token: required on every API call when configured.
      if (adminToken) {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '')
        if (!m || m[1] !== adminToken) return send(res, 401, { error: { message: 'admin token required' } })
      }

      // CSRF guard on mutations: a custom header a cross-site form cannot set.
      const mutating = method !== 'GET'
      if (mutating && req.headers['x-codex-bridge-admin'] !== '1') {
        return send(res, 403, { error: { message: 'missing x-codex-bridge-admin header' } })
      }

      if (method === 'GET' && path === '/api/config') {
        return send(res, 200, { fields: describe(config), status: getStatus() })
      }

      if (method === 'GET' && path === '/api/status') {
        return send(res, 200, getStatus())
      }

      if (method === 'GET' && path === '/api/logs') {
        const since = Number(url.searchParams.get('since') || 0) || 0
        return send(res, 200, getLogs ? getLogs(since) : { entries: [], lastSeq: 0 })
      }

      if (method === 'GET' && path === '/api/fs') {
        return send(res, 200, listDir(url.searchParams.get('path')))
      }

      if (method === 'PUT' && path === '/api/config') {
        const body = await readBody(req)
        const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {}

        // Validate before applying.
        if ('apiKey' in patch && !config.isEnvOverridden('apiKey')) {
          const k = String(patch.apiKey || '')
          if (k && k.length < 16) return send(res, 400, { error: { message: 'API key must be at least 16 characters' } })
        }
        let missingPaths = []
        if (Array.isArray(patch.repos)) {
          for (const r of patch.repos) {
            if (!r || !r.url || !r.path) return send(res, 400, { error: { message: 'each repo needs a url and a path' } })
            if (!existsSync(r.path)) missingPaths.push(r.path)
          }
        }

        const changed = config.update(patch)
        const restart = changed.some((k) => config.needsRestart(k))
        return send(res, 200, { changed, restartRequired: restart, warnings: missingPaths.map((p) => `path does not exist: ${p}`) })
      }

      if (method === 'POST' && path === '/api/regenerate-key') {
        const key = config.regenerateKey()
        if (!key) return send(res, 409, { error: { message: 'API key is fixed by the environment' } })
        return send(res, 200, { apiKey: key })
      }

      if (method === 'POST' && path === '/api/reveal') {
        const body = await readBody(req)
        const key = String(body?.key || '')
        if (!config.isSecret(key)) return send(res, 400, { error: { message: 'not a secret field' } })
        return send(res, 200, { key, value: config.values[key] || '' })
      }

      return send(res, 404, { error: { message: 'not found' } })
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: { message: e?.message || 'internal error' } })
    }
  })
  return server
}

// ---------- the page (self-contained: inline CSS + JS, no framework) ----------
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codex-bridge · config</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1d212b; --line: #2a2f3a;
    --text: #e6e8ee; --muted: #9aa3b2; --accent: #5b8cff; --accent-2:#7aa2ff;
    --ok: #3fb950; --warn: #d29922; --err: #f85149; --radius: 10px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  header h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 0 transparent; }
  .dot.on { background: var(--ok); box-shadow: 0 0 0 4px rgba(63,185,80,.15); }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
  .sub code { font-family: var(--mono); background: var(--panel-2); padding: 1px 6px; border-radius: 6px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 18px 6px; margin-bottom: 18px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 14px; font-weight: 600; }
  .row { display: grid; grid-template-columns: 200px 1fr; gap: 14px; align-items: center; padding: 9px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: 0; }
  .row > label { color: var(--muted); font-size: 13px; }
  .row .val { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input[type=text], input[type=number], select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 10px; font: inherit; min-width: 220px; flex: 1;
  }
  input[type=text].mono { font-family: var(--mono); }
  input:disabled, select:disabled { opacity: .55; cursor: not-allowed; }
  input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 12px; font: inherit; cursor: pointer; white-space: nowrap;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { background: var(--accent-2); }
  button.ghost { background: transparent; }
  button.danger:hover { border-color: var(--err); color: var(--err); }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .pill.env { color: var(--warn); border-color: rgba(210,153,34,.4); }
  .pill.restart { color: var(--accent-2); border-color: rgba(122,162,255,.4); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  td input { min-width: 0; width: 100%; }
  .repo-warn { color: var(--warn); font-size: 12px; }
  .actions { position: sticky; bottom: 0; background: linear-gradient(transparent, var(--bg) 40%); padding-top: 24px; display: flex; gap: 10px; align-items: center; }
  .toast { margin-left: auto; font-size: 13px; }
  .toast.ok { color: var(--ok); } .toast.err { color: var(--err); } .toast.warn { color: var(--warn); }
  .hint { color: var(--muted); font-size: 12px; }
  a { color: var(--accent-2); }
  .logbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .logbar select { min-width: 120px; flex: 0 0 auto; }
  .logview { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; height: 280px; overflow: auto; padding: 8px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.65; }
  .logrow { white-space: pre-wrap; word-break: break-word; }
  .logrow .lt { color: var(--muted); }
  .logrow .lk { display: inline-block; min-width: 50px; font-weight: 600; }
  .logrow.req .lk { color: var(--accent-2); }
  .logrow.audit .lk { color: var(--ok); }
  .logrow.error .lk { color: var(--err); }
  .logrow.info .lk { color: var(--muted); }
  .pathcell { display: flex; gap: 6px; align-items: center; }
  .pathcell input { min-width: 0; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; z-index: 50; }
  .modal-backdrop.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; width: min(640px, 92vw); max-height: 82vh; display: flex; flex-direction: column; padding: 16px; }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .modal-head strong { font-size: 15px; }
  .fs-path { display: flex; gap: 6px; margin-bottom: 10px; }
  .fs-path input { flex: 1; }
  .fs-list { flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: 8px; min-height: 240px; }
  .fs-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--line); font-family: var(--mono); font-size: 13px; }
  .fs-item:last-child { border-bottom: 0; }
  .fs-item:hover { background: var(--panel-2); }
  .fs-item .ic { color: var(--accent-2); }
  .fs-empty { padding: 16px 12px; color: var(--muted); font-size: 13px; }
  .modal-foot { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .modal-foot .hint { margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <header><span class="dot" id="dot"></span><h1>codex-bridge</h1></header>
  <p class="sub" id="statusline">loading…</p>

  <div class="card" id="card-logs">
    <h2>Activity log <span class="hint">— live, most recent 500 events</span></h2>
    <div class="logbar">
      <select id="logFilter">
        <option value="">all</option>
        <option value="req">requests</option>
        <option value="audit">audit (codex)</option>
        <option value="error">errors</option>
      </select>
      <button class="ghost" id="logPause" type="button">Pause</button>
      <button class="ghost" id="logClear" type="button">Clear view</button>
      <label class="hint" style="margin-left:auto"><input type="checkbox" id="logFollow" checked /> follow</label>
    </div>
    <div class="logview" id="logView"><div class="hint">waiting for activity…</div></div>
    <p class="hint">Requests (method · path · status · time), codex actions (audit), and errors. Toggle request logging in “Network &amp; advanced”. Tail the console window or a file for the full history.</p>
  </div>

  <div class="card" id="card-key">
    <h2>Authentication</h2>
    <div class="row">
      <label>API key</label>
      <div class="val">
        <input type="text" class="mono" id="apiKey" placeholder="(generated on first run)" />
        <button class="ghost" id="reveal" type="button">Reveal</button>
        <button class="ghost" id="copyKey" type="button">Copy</button>
        <button class="danger" id="regen" type="button">Regenerate</button>
      </div>
    </div>
    <p class="hint">The bearer key the dashboard sends. Min 16 chars (32-byte hex generated by default).</p>
  </div>

  <div class="card">
    <h2>Repositories <span class="hint">— codex may only operate on these</span></h2>
    <table id="repos">
      <thead><tr><th style="width:45%">URL (dashboard allowlist)</th><th style="width:45%">Local path (codex cwd)</th><th></th></tr></thead>
      <tbody id="reposBody"></tbody>
    </table>
    <div style="padding:10px 0"><button id="addRepo" type="button">+ Add repository</button></div>
  </div>

  <div class="card" id="card-policy">
    <h2>Execution policy</h2>
    <div class="row"><label>Sandbox</label><div class="val">
      <select id="sandbox">
        <option value="read-only">read-only — read only</option>
        <option value="workspace-write">workspace-write — write/run inside repo only (default)</option>
        <option value="danger-full-access">danger-full-access — ⚠ full machine + network</option>
        <option value="config">config — defer to ~/.codex/config.toml</option>
      </select></div></div>
    <div class="row"><label>Approval policy</label><div class="val">
      <select id="approvalPolicy">
        <option value="never">never — auto-approve (default)</option>
        <option value="on-request">on-request</option>
        <option value="untrusted">untrusted</option>
        <option value="config">config — defer to ~/.codex/config.toml</option>
      </select></div></div>
    <div class="row"><label>Auto-approve</label><div class="val"><input type="checkbox" id="autoApprove" /> <span class="hint">defensive net for stray approval requests</span></div></div>
    <div class="row"><label>Default model</label><div class="val"><input type="text" id="model" placeholder="(codex default)" /></div></div>
  </div>

  <div class="card" id="card-net">
    <h2>Network &amp; advanced</h2>
    <div class="row"><label>API host</label><div class="val"><input type="text" id="host" /></div></div>
    <div class="row"><label>API port</label><div class="val"><input type="number" id="port" /></div></div>
    <div class="row"><label>Admin port</label><div class="val"><input type="number" id="adminPort" /></div></div>
    <div class="row"><label>codex binary</label><div class="val"><input type="text" id="codexBin" /></div></div>
    <div class="row"><label>Audit log path</label><div class="val"><input type="text" id="auditLog" placeholder="(stdout only)" /></div></div>
    <div class="row"><label>Request log</label><div class="val"><input type="checkbox" id="requestLog" /> <span class="hint">one line per HTTP request on stdout (skips healthz/status polls)</span></div></div>
    <div class="row"><label>Request log file</label><div class="val"><input type="text" id="requestLogFile" placeholder="(stdout only)" /></div></div>
    <div class="row"><label>Admin token</label><div class="val"><input type="text" class="mono" id="adminToken" placeholder="(none — loopback only)" /></div></div>
    <div class="row"><label>Debug logging</label><div class="val"><input type="checkbox" id="debug" /></div></div>
  </div>

  <div class="actions">
    <button class="primary" id="save" type="button">Save changes</button>
    <button class="ghost" id="reload" type="button">Reload</button>
    <span class="toast" id="toast"></span>
  </div>
</div>

<div class="modal-backdrop" id="fsModal">
  <div class="modal">
    <div class="modal-head"><strong>Select a folder</strong><button class="ghost" id="fsClose" type="button">✕</button></div>
    <div class="fs-path">
      <input type="text" class="mono" id="fsCurrent" placeholder="/path/to/folder" />
      <button class="ghost" id="fsGo" type="button">Go</button>
    </div>
    <div class="fs-list" id="fsList"></div>
    <div class="modal-foot">
      <span class="hint" id="fsHint"></span>
      <button class="ghost" id="fsHome" type="button">Home</button>
      <button class="ghost" id="fsUp" type="button">↑ Up</button>
      <button class="primary" id="fsSelect" type="button">Select this folder</button>
    </div>
  </div>
</div>

<script>
const H = { 'x-codex-bridge-admin': '1', 'Content-Type': 'application/json' };
let TOKEN = localStorage.getItem('cbAdminToken') || '';
function authH(extra) { const h = Object.assign({}, extra || {}); if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN; return h; }
const $ = (id) => document.getElementById(id);
const toast = (msg, kind) => { const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind||''); if (msg) setTimeout(() => { if (t.textContent===msg) { t.textContent=''; t.className='toast'; } }, 4000); };

let FIELDS = {}; // key -> descriptor

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: authH(H) }, opts || {}));
  if (r.status === 401) { promptToken(); throw new Error('admin token required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}
function promptToken() {
  const t = prompt('Admin token required:');
  if (t) { TOKEN = t; localStorage.setItem('cbAdminToken', t); load(); }
}

function setVal(key, value) { const el = $(key); if (!el) return; if (el.type === 'checkbox') el.checked = !!value; else el.value = value == null ? '' : value; }
function getVal(key, type) { const el = $(key); if (!el) return undefined; if (el.type === 'checkbox') return el.checked; if (type === 'number') return Number(el.value); return el.value; }

function applyMeta(key) {
  const f = FIELDS[key]; const el = $(key); if (!f || !el) return;
  const cell = el.closest('.val'); if (!cell) return;
  cell.querySelectorAll('.pill').forEach((p) => p.remove());
  if (f.envOverridden) { el.disabled = true; const s = document.createElement('span'); s.className = 'pill env'; s.textContent = 'from env'; cell.appendChild(s); }
  if (f.needsRestart) { const s = document.createElement('span'); s.className = 'pill restart'; s.textContent = 'restart to apply'; cell.appendChild(s); }
}

function renderRepos(repos) {
  const body = $('reposBody'); body.innerHTML = '';
  (repos || []).forEach((r) => addRepoRow(r.url, r.path));
  if (!repos || !repos.length) addRepoRow('', '');
}
function addRepoRow(url, path) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" class="r-url" placeholder="github.com/acme/repo"></td>'
    + '<td><div class="pathcell"><input type="text" class="mono r-path" placeholder="/srv/repos/repo"><button class="ghost r-browse" type="button">Browse…</button></div></td>'
    + '<td><button class="ghost danger r-del" type="button">✕</button></td>';
  tr.querySelector('.r-url').value = url || '';
  tr.querySelector('.r-path').value = path || '';
  tr.querySelector('.r-del').onclick = () => tr.remove();
  tr.querySelector('.r-browse').onclick = () => openFs(tr.querySelector('.r-path'));
  $('reposBody').appendChild(tr);
}
function collectRepos() {
  const rows = [...document.querySelectorAll('#reposBody tr')];
  return rows.map((tr) => ({ url: tr.querySelector('.r-url').value.trim(), path: tr.querySelector('.r-path').value.trim() }))
    .filter((r) => r.url || r.path);
}

async function load() {
  try {
    const { fields, status } = await api('/api/config');
    FIELDS = {}; fields.forEach((f) => (FIELDS[f.key] = f));
    for (const f of fields) {
      if (f.key === 'repos') { renderRepos(f.value); continue; }
      if (f.key === 'apiKey') { setVal('apiKey', f.set ? f.value : ''); $('apiKey').dataset.masked = '1'; }
      else setVal(f.key, f.value);
    }
    Object.keys(FIELDS).forEach(applyMeta);
    paintStatus(status);
    toast('');
  } catch (e) { toast(e.message, 'err'); }
}

function paintStatus(s) {
  $('dot').className = 'dot' + (s && s.running ? ' on' : '');
  const parts = [];
  if (s) {
    parts.push('codex ' + (s.codexVersion || '?'));
    parts.push('API on <code>' + s.apiUrl + '</code>');
    parts.push('admin on <code>' + s.adminUrl + '</code>');
    parts.push((s.repoCount || 0) + ' repo' + (s.repoCount === 1 ? '' : 's'));
    if (s.activeRuns) parts.push(s.activeRuns + ' active run' + (s.activeRuns === 1 ? '' : 's'));
    parts.push('config: <code>' + s.configPath + '</code>');
  }
  $('statusline').innerHTML = parts.join(' · ');
}

$('reveal').onclick = async () => {
  try { const { value } = await api('/api/reveal', { method: 'POST', headers: authH(H), body: JSON.stringify({ key: 'apiKey' }) });
    const el = $('apiKey'); el.value = value; el.dataset.masked = ''; } catch (e) { toast(e.message, 'err'); }
};
$('copyKey').onclick = async () => {
  try { const { value } = await api('/api/reveal', { method: 'POST', headers: authH(H), body: JSON.stringify({ key: 'apiKey' }) });
    await navigator.clipboard.writeText(value); toast('API key copied', 'ok'); } catch (e) { toast('copy failed: ' + e.message, 'err'); }
};
$('regen').onclick = async () => {
  if (!confirm('Generate a new API key? The dashboard must be updated with the new value.')) return;
  try { const { apiKey } = await api('/api/regenerate-key', { method: 'POST', headers: authH(H), body: '{}' });
    const el = $('apiKey'); el.value = apiKey; el.dataset.masked = ''; toast('New key generated & saved', 'ok'); } catch (e) { toast(e.message, 'err'); }
};
$('addRepo').onclick = () => addRepoRow('', '');
$('reload').onclick = load;

$('save').onclick = async () => {
  const patch = {};
  const simple = { sandbox:'string', approvalPolicy:'string', autoApprove:'bool', model:'string', host:'string', port:'number', adminPort:'number', codexBin:'string', auditLog:'string', requestLog:'bool', requestLogFile:'string', adminToken:'string', debug:'bool' };
  for (const [key, type] of Object.entries(simple)) { if (FIELDS[key] && !FIELDS[key].envOverridden) patch[key] = getVal(key, type); }
  if (FIELDS.repos && !FIELDS.repos.envOverridden) patch.repos = collectRepos();
  // Only send apiKey if the user edited it (not still masked).
  const keyEl = $('apiKey');
  if (FIELDS.apiKey && !FIELDS.apiKey.envOverridden && keyEl.dataset.masked !== '1' && keyEl.value) patch.apiKey = keyEl.value.trim();
  try {
    const r = await api('/api/config', { method: 'PUT', headers: authH(H), body: JSON.stringify({ patch }) });
    let msg = 'Saved' + (r.changed.length ? ' (' + r.changed.join(', ') + ')' : ' — no changes');
    if (r.warnings && r.warnings.length) { toast(msg + ' · ' + r.warnings.join('; '), 'warn'); }
    else if (r.restartRequired) { toast(msg + ' · restart required for host/port', 'warn'); }
    else toast(msg, 'ok');
    load();
  } catch (e) { toast(e.message, 'err'); }
};

// ---- activity log ----
let LOG_SINCE = 0, LOG_PAUSED = false;
const LOG_KINDS = { req: 'REQ', audit: 'AUDIT', error: 'ERROR', info: 'INFO' };
const logTime = (ts) => (ts || '').slice(11, 19);
function appendLogs(entries) {
  const view = $('logView');
  const placeholder = view.querySelector('.hint'); if (placeholder && entries.length) placeholder.remove();
  const filter = $('logFilter').value;
  let added = false;
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'logrow ' + e.kind;
    row.dataset.kind = e.kind;
    if (filter && e.kind !== filter) row.style.display = 'none';
    row.innerHTML = '<span class="lt"></span> <span class="lk"></span> <span class="lm"></span>';
    row.querySelector('.lt').textContent = logTime(e.ts);
    row.querySelector('.lk').textContent = LOG_KINDS[e.kind] || e.kind;
    row.querySelector('.lm').textContent = e.msg;
    view.appendChild(row);
    added = true;
  }
  while (view.children.length > 800) view.removeChild(view.firstChild);
  if (added && $('logFollow').checked) view.scrollTop = view.scrollHeight;
}
async function pollLogs() {
  if (LOG_PAUSED) return;
  try { const r = await api('/api/logs?since=' + LOG_SINCE); LOG_SINCE = r.lastSeq; appendLogs(r.entries || []); } catch {}
}
$('logFilter').onchange = () => {
  const f = $('logFilter').value;
  [...$('logView').children].forEach((c) => { if (c.dataset && c.dataset.kind) c.style.display = (!f || c.dataset.kind === f) ? '' : 'none'; });
};
$('logPause').onclick = () => { LOG_PAUSED = !LOG_PAUSED; $('logPause').textContent = LOG_PAUSED ? 'Resume' : 'Pause'; };
$('logClear').onclick = () => { $('logView').innerHTML = ''; };

// ---- folder picker (server-side directory browser) ----
let fsTarget = null, fsParent = null, fsHomeDir = null;
function openFs(input) { fsTarget = input; $('fsModal').classList.add('open'); fsNavigate(input.value || ''); }
function closeFs() { $('fsModal').classList.remove('open'); fsTarget = null; }
async function fsNavigate(p) {
  try {
    const r = await api('/api/fs?path=' + encodeURIComponent(p || ''));
    $('fsCurrent').value = r.path;
    fsParent = r.parent; fsHomeDir = r.home;
    const list = $('fsList'); list.innerHTML = '';
    if (r.error) { const d = document.createElement('div'); d.className = 'fs-empty'; d.textContent = 'Cannot read: ' + r.error; list.appendChild(d); }
    else if (!r.entries.length) { const d = document.createElement('div'); d.className = 'fs-empty'; d.textContent = '(no sub-folders here)'; list.appendChild(d); }
    for (const e of r.entries) {
      const row = document.createElement('div'); row.className = 'fs-item';
      row.innerHTML = '<span class="ic">\\uD83D\\uDCC1</span><span class="nm"></span>';
      row.querySelector('.nm').textContent = e.name;
      row.onclick = () => fsNavigate(e.path);
      list.appendChild(row);
    }
    $('fsHint').textContent = r.path;
    $('fsUp').disabled = !fsParent;
  } catch (e) { toast(e.message, 'err'); }
}
$('fsClose').onclick = closeFs;
$('fsUp').onclick = () => { if (fsParent) fsNavigate(fsParent); };
$('fsHome').onclick = () => fsNavigate(fsHomeDir || '');
$('fsGo').onclick = () => fsNavigate($('fsCurrent').value);
$('fsCurrent').onkeydown = (ev) => { if (ev.key === 'Enter') fsNavigate($('fsCurrent').value); };
$('fsSelect').onclick = () => { if (fsTarget) fsTarget.value = $('fsCurrent').value; closeFs(); };
$('fsModal').onclick = (ev) => { if (ev.target === $('fsModal')) closeFs(); };

if (TOKEN) {} // already have one
load();
pollLogs();
setInterval(pollLogs, 1500);
setInterval(async () => { try { const s = await api('/api/status'); paintStatus(s); } catch {} }, 5000);
</script>
</body>
</html>`
