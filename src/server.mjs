// codex-bridge/server.mjs
//
// HTTP gateway that makes a local `codex app-server` look like the Cursor
// remote-agent API, so the dashboard's codex-runner integration can drive it
// over the network. Zero npm dependencies (node:http / node:crypto / built-ins).
//
// Ships as a one-click self-contained binary (built with Bun). On first run it
// auto-generates a config file with a strong CODEX_BRIDGE_API_KEY, starts the
// API, and opens a local admin/config page (loopback-only) in the browser so
// repos and policy can be edited from a GUI. See README.
//
// SECURITY: this process can run arbitrary code on this machine via codex.
// The API MUST be:
//   • reachable only over TLS (put it behind nginx/caddy; do not expose :PORT raw)
//   • protected by a strong bearer key (CODEX_BRIDGE_API_KEY)
//   • scoped to an explicit repo allowlist (the "Repositories" list)
//   • run as a low-privilege user, ideally in a dedicated VM/container
// The admin page binds to loopback only and is never meant to be behind the proxy.

import http from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { CodexAppServerClient } from './codex-client.mjs'
import { Config } from './config.mjs'
import { createAdminServer } from './admin-ui.mjs'

// ---------- config (live: re-read on every request so the admin UI can edit it) ----------
const cfg = new Config()
cfg.load()

// Commands the defensive approval net always declines, even with autoApprove.
const DENY_PATTERNS = [/\brm\s+-rf\s+\/(?!\w)/, /\bmkfs\b/, /\b:\(\)\s*\{/, /\bshutdown\b/, /\breboot\b/, /\bdd\s+if=/]

const effectiveKey = cfg.values.apiKey
if (!effectiveKey || effectiveKey.length < 16) {
  console.error('[codex-bridge] CODEX_BRIDGE_API_KEY must be at least 16 chars (set a valid value in the environment, or unset it to auto-generate one)')
  process.exit(1)
}

function normalizeRepoUrl(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

/** Current allowlist, derived live from config (repos can change at runtime). */
function findRepo(url) {
  const n = normalizeRepoUrl(url)
  for (const r of cfg.values.repos) {
    if (normalizeRepoUrl(r.url) === n) return { url: r.url, path: r.path }
  }
  return null
}

// ---------- in-memory log buffer (so the admin GUI can show recent activity) ----------
// A small ring buffer of the most recent log entries. The GUI polls /api/logs and
// renders these; stdout / files are unaffected. kind: 'req' | 'audit' | 'error' | 'info'.
const LOG_MAX = 500
const LOG_BUFFER = []
let LOG_SEQ = 0
function pushLog(kind, msg) {
  LOG_BUFFER.push({ seq: ++LOG_SEQ, ts: new Date().toISOString(), kind, msg: String(msg) })
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift()
}
function getLogs(since = 0) {
  const entries = since > 0 ? LOG_BUFFER.filter((e) => e.seq > since) : LOG_BUFFER.slice()
  return { entries, lastSeq: LOG_SEQ }
}

// ---------- audit ----------
async function audit(event, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data })
  console.log(`[codex-bridge][audit] ${line}`)
  pushLog('audit', `${event} ${JSON.stringify(data)}`)
  const auditLog = cfg.values.auditLog
  if (auditLog) {
    try {
      await appendFile(auditLog, line + '\n')
    } catch (e) {
      console.error('[codex-bridge] audit write failed:', e.message)
    }
  }
}

// ---------- codex version (best effort) ----------
let CODEX_VERSION = 'unknown'
execFile(cfg.values.codexBin || 'codex', ['--version'], (err, stdout) => {
  if (!err && stdout) CODEX_VERSION = String(stdout).trim()
})

// ---------- turn/thread state ----------
// threads: agentId(threadId) -> { repoUrl, cwd }
const threads = new Map()
// runs: runId(turnId) -> { agentId, status, startedAt, finishedAt, text, deltaText, commands[], error }
const runs = new Map()

function ensureRun(turnId, agentId) {
  let run = runs.get(turnId)
  if (!run) {
    run = { agentId, status: 'inProgress', startedAt: Date.now(), finishedAt: null, text: '', deltaText: '', commands: [], error: null }
    runs.set(turnId, run)
  } else if (agentId && !run.agentId) {
    run.agentId = agentId
  }
  return run
}

function pickText(obj) {
  if (!obj || typeof obj !== 'object') return ''
  // Tolerant extraction across plausible agentMessage shapes.
  return String(obj.text || obj.content || obj.message || obj?.message?.text || '')
}

function assembleResult(run) {
  const parts = []
  const body = (run.text && run.text.trim()) || (run.deltaText && run.deltaText.trim())
  if (body) parts.push(body)
  if (run.commands.length > 0) {
    const lines = run.commands.map((c) => {
      const status = c.exitCode === 0 || c.status === 'completed' ? '✓' : '✗'
      return `- ${status} \`${c.command}\`${c.exitCode != null ? ` (exit ${c.exitCode})` : ''}`
    })
    parts.push(['**Commands run:**', ...lines].join('\n'))
  }
  if (run.error) parts.push(`**Error:** ${run.error}`)
  return parts.join('\n\n')
}

// ---------- codex client + notification wiring ----------
const codex = new CodexAppServerClient({
  command: cfg.values.codexBin || 'codex',
  debug: cfg.values.debug,
  onApproval: async (method, params) => {
    const command = Array.isArray(params.command) ? params.command.join(' ') : String(params.command || '')
    if (!cfg.values.autoApprove) {
      await audit('approval-declined', { method, command, cwd: params.cwd, reason: 'auto-approve disabled' })
      return 'decline'
    }
    if (DENY_PATTERNS.some((re) => re.test(command))) {
      await audit('approval-declined', { method, command, cwd: params.cwd, reason: 'denylist' })
      return 'decline'
    }
    await audit('approval-accepted', { method, command, cwd: params.cwd })
    return 'accept'
  },
})

codex.on('notification', (method, params) => {
  try {
    handleNotification(method, params)
  } catch (e) {
    console.error('[codex-bridge] notification handler error:', e?.message)
    pushLog('error', `notification handler: ${e?.message}`)
  }
})

function resolveRunForItem(params) {
  // Notifications may carry turnId; if so use it. Otherwise attach to the single
  // in-progress run when unambiguous (sequential single-turn case). Documented
  // best-effort: the source of truth for the final result is turn/completed.
  if (params.turnId && runs.has(params.turnId)) return runs.get(params.turnId)
  const inProgress = [...runs.values()].filter((r) => r.status === 'inProgress')
  return inProgress.length === 1 ? inProgress[0] : null
}

function handleNotification(method, params) {
  switch (method) {
    case 'turn/started': {
      const id = params?.turn?.id
      if (id) ensureRun(id, params?.turn?.threadId)
      break
    }
    case 'turn/completed': {
      const t = params?.turn
      if (!t?.id) break
      const run = ensureRun(t.id, t.threadId)
      run.status = t.status || 'completed'
      run.finishedAt = Date.now()
      if (t.error) run.error = typeof t.error === 'string' ? t.error : t.error?.message || JSON.stringify(t.error)
      // Prefer the final items array if present.
      if (Array.isArray(t.items)) {
        const texts = t.items.filter((it) => it?.type === 'agentMessage').map(pickText).filter(Boolean)
        if (texts.length) run.text = texts.join('\n\n')
        for (const it of t.items) {
          if (it?.type === 'commandExecution') {
            run.commands.push({
              command: Array.isArray(it.command) ? it.command.join(' ') : String(it.command || ''),
              exitCode: it.exitCode ?? it?.result?.exitCode ?? null,
              status: it.status,
            })
          }
        }
      }
      audit('turn-completed', { turnId: t.id, status: run.status })
      break
    }
    case 'item/agentMessage/delta': {
      const run = resolveRunForItem(params)
      if (run) run.deltaText += String(params.delta || '')
      break
    }
    case 'item/completed': {
      const item = params?.item || params
      if (item?.type === 'agentMessage') {
        const run = resolveRunForItem(params)
        const txt = pickText(item)
        if (run && txt) run.text = run.text ? `${run.text}\n\n${txt}` : txt
      } else if (item?.type === 'commandExecution') {
        const run = resolveRunForItem(params)
        if (run) {
          run.commands.push({
            command: Array.isArray(item.command) ? item.command.join(' ') : String(item.command || ''),
            exitCode: item.exitCode ?? item?.result?.exitCode ?? null,
            status: item.status,
          })
        }
      }
      break
    }
    case 'error': {
      const run = resolveRunForItem(params)
      if (run) run.error = params?.message || 'codex error'
      break
    }
    default:
      break
  }
}

// ---------- http helpers ----------
function checkAuth(req) {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) return false
  const provided = Buffer.from(m[1])
  const expected = Buffer.from(cfg.values.apiKey)
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json' })
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

function runView(turnId) {
  const run = runs.get(turnId)
  if (!run) return null
  return {
    id: turnId,
    status: run.status,
    result: assembleResult(run),
    durationMs: run.finishedAt ? run.finishedAt - run.startedAt : Date.now() - run.startedAt,
  }
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname
  const method = req.method || 'GET'

  // healthz is unauthenticated (liveness only).
  if (method === 'GET' && path === '/v1/healthz') {
    return send(res, 200, { ok: true, codexVersion: CODEX_VERSION })
  }

  if (!checkAuth(req)) {
    return send(res, 401, { error: { message: 'unauthorized' } })
  }

  // GET /v1/me
  if (method === 'GET' && path === '/v1/me') {
    return send(res, 200, { apiKeyName: 'codex-bridge', codexVersion: CODEX_VERSION })
  }

  // GET /v1/repos — configured allowlist identifiers, for the dashboard
  // "load from bridge". Only the url labels are returned, never the local paths.
  if (method === 'GET' && path === '/v1/repos') {
    return send(res, 200, { items: cfg.values.repos.map((r) => ({ url: r.url })) })
  }

  // POST /v1/agents  (launch)
  if (method === 'POST' && path === '/v1/agents') {
    const body = await readBody(req)
    const repoUrl = body?.repos?.[0]?.url
    const repo = findRepo(repoUrl)
    if (!repo) {
      await audit('launch-rejected', { repoUrl, reason: 'not in allowlist' })
      return send(res, 403, { error: { message: `repository "${repoUrl}" is not in the bridge allowlist` } })
    }
    const promptText = String(body?.prompt?.text || '').trim()
    if (!promptText) return send(res, 400, { error: { message: 'prompt.text is required' } })
    const model = body?.model?.id || cfg.values.model || undefined

    // Build sandbox/approval params live from config ('config' => don't override on the wire).
    const sandbox = cfg.values.sandbox
    const approvalPolicy = cfg.values.approvalPolicy
    const sandboxParam = sandbox && sandbox !== 'config' ? { sandbox } : {}
    const approvalParam = approvalPolicy && approvalPolicy !== 'config' ? { approvalPolicy } : {}

    await codex.start()
    const startRes = await codex.request('thread/start', {
      cwd: repo.path,
      ...approvalParam,
      ...sandboxParam,
      serviceName: 'codex-bridge',
      ...(model ? { model } : {}),
    })
    const threadId = startRes?.thread?.id
    if (!threadId) return send(res, 502, { error: { message: 'codex returned no thread id' } })
    threads.set(threadId, { repoUrl: repo.url, cwd: repo.path })

    const turnRes = await codex.request('turn/start', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: promptText }],
      ...approvalParam,
      ...(model ? { model } : {}),
    })
    const turnId = turnRes?.turn?.id
    if (!turnId) return send(res, 502, { error: { message: 'codex returned no turn id' } })
    const run = ensureRun(turnId, threadId)
    run.status = turnRes?.turn?.status || 'inProgress'
    await audit('launch', { agentId: threadId, runId: turnId, repo: repo.url, cwd: repo.path })
    return send(res, 200, { agent: { id: threadId }, run: { id: turnId, status: run.status } })
  }

  // POST /v1/agents/:id/runs  (followup)  &  POST /v1/agents/:id/cancel
  const agentSub = /^\/v1\/agents\/([^/]+)\/(runs|cancel)$/.exec(path)
  if (method === 'POST' && agentSub) {
    const agentId = decodeURIComponent(agentSub[1])
    const thread = threads.get(agentId)
    if (!thread) return send(res, 404, { error: { message: `unknown agent "${agentId}"` } })
    const body = await readBody(req)

    if (agentSub[2] === 'cancel') {
      const runId = String(body?.runId || '')
      await codex.request('turn/interrupt', { threadId: agentId, turnId: runId })
      await audit('cancel', { agentId, runId })
      return send(res, 200, { ok: true })
    }

    // followup
    const promptText = String(body?.prompt?.text || '').trim()
    if (!promptText) return send(res, 400, { error: { message: 'prompt.text is required' } })
    const approvalPolicy = cfg.values.approvalPolicy
    const approvalParam = approvalPolicy && approvalPolicy !== 'config' ? { approvalPolicy } : {}
    const turnRes = await codex.request('turn/start', {
      threadId: agentId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: promptText }],
      ...approvalParam,
    })
    const turnId = turnRes?.turn?.id
    if (!turnId) return send(res, 502, { error: { message: 'codex returned no turn id' } })
    const run = ensureRun(turnId, agentId)
    run.status = turnRes?.turn?.status || 'inProgress'
    await audit('followup', { agentId, runId: turnId })
    return send(res, 200, { run: { id: turnId, status: run.status } })
  }

  // GET /v1/agents/:id/runs/:runId  (status)
  const runMatch = /^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/.exec(path)
  if (method === 'GET' && runMatch) {
    const runId = decodeURIComponent(runMatch[2])
    const view = runView(runId)
    if (!view) return send(res, 404, { error: { message: `unknown run "${runId}"` } })
    return send(res, 200, { run: view })
  }

  // GET /v1/agents/:id  (repo guard metadata)
  const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(path)
  if (method === 'GET' && agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1])
    const thread = threads.get(agentId)
    if (!thread) return send(res, 404, { error: { message: `unknown agent "${agentId}"` } })
    return send(res, 200, { repos: [{ url: thread.repoUrl }] })
  }

  return send(res, 404, { error: { message: 'not found' } })
}

// ---------- request logger ----------
// One line per finished HTTP request, on stdout (and to requestLogFile as JSONL
// if set). Never logs the Authorization header or the query string — paths only —
// so bearer tokens / secrets can't leak into the log. Pure liveness/poll endpoints
// are skipped to keep the log signal-rich.
function logRequest(serverName, req, res, startedAt) {
  if (!cfg.values.requestLog) return
  let path = req.url || '/'
  const q = path.indexOf('?')
  if (q !== -1) path = path.slice(0, q)
  if (path === '/v1/healthz' || path === '/api/status' || path === '/api/logs') return
  const ms = Date.now() - startedAt
  const ip = req.socket?.remoteAddress || '-'
  const method = req.method || '-'
  const status = res.statusCode
  console.log(`[codex-bridge][req] ${serverName} ${ip} ${method} ${path} ${status} ${ms}ms`)
  pushLog('req', `${serverName} ${ip} ${method} ${path} ${status} ${ms}ms`)
  const file = cfg.values.requestLogFile
  if (file) {
    const line = JSON.stringify({ ts: new Date().toISOString(), kind: 'request', server: serverName, ip, method, path, status, ms })
    appendFile(file, line + '\n').catch((e) => console.error('[codex-bridge] request-log write failed:', e.message))
  }
}

// ---------- open the admin page in the default browser ----------
function openBrowser(targetUrl) {
  try {
    const p = platform()
    const cmd = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open'
    const args = p === 'win32' ? ['/c', 'start', '', targetUrl] : [targetUrl]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref?.()
  } catch {
    /* best effort */
  }
}

// ---------- status for the admin UI ----------
function getStatus() {
  const v = cfg.values
  const activeRuns = [...runs.values()].filter((r) => r.status === 'inProgress').length
  return {
    running: true,
    codexVersion: CODEX_VERSION,
    apiUrl: `http://${v.host}:${v.port}`,
    adminUrl: `http://127.0.0.1:${v.adminPort}`,
    repoCount: v.repos.length,
    activeRuns,
    configPath: cfg.path,
  }
}

// ---------- boot ----------
const apiServer = http.createServer((req, res) => {
  const t0 = Date.now()
  res.on('finish', () => logRequest('api', req, res, t0))
  handle(req, res).catch((e) => {
    console.error('[codex-bridge] request error:', e?.message)
    pushLog('error', `request error: ${e?.message}`)
    if (!res.headersSent) send(res, 500, { error: { message: e?.message || 'internal error' } })
  })
})

const adminServer = createAdminServer({ config: cfg, getStatus, getLogs, logRequest })

const v = cfg.values
apiServer.listen(v.port, v.host, () => {
  console.log(`[codex-bridge] API listening on http://${v.host}:${v.port}`)
  console.log(`[codex-bridge] approvalPolicy=${v.approvalPolicy} sandbox=${v.sandbox} autoApprove=${v.autoApprove}`)
  const repoList = v.repos.map((r) => r.url).join(', ') || '(none — add some in the admin page)'
  console.log(`[codex-bridge] allowed repos: ${repoList}`)
  if (v.repos.length === 0) {
    console.warn('[codex-bridge] no repositories configured yet — /v1/agents launches will 403 until you add one')
  }
})

// Admin UI is always loopback-only, on its own port, never behind the proxy.
adminServer.listen(v.adminPort, '127.0.0.1', () => {
  const adminUrl = `http://127.0.0.1:${v.adminPort}`
  console.log(`[codex-bridge] admin/config UI on ${adminUrl}`)
  console.log(`[codex-bridge] config file: ${cfg.path}`)

  // Open the browser on first run, or whenever there's nothing to serve yet,
  // unless explicitly disabled or the value clearly can't open a browser.
  const wantOpen = process.env.CODEX_BRIDGE_NO_OPEN !== '1' && !process.argv.includes('--no-open')
  const shouldOpen = wantOpen && (cfg.createdNow || cfg.generatedKey || cfg.values.repos.length === 0 || process.argv.includes('--open'))
  if (shouldOpen) {
    if (cfg.generatedKey) console.log('[codex-bridge] first run: generated a new API key — opening the config page…')
    openBrowser(adminUrl)
  }
})

function shutdown() {
  console.log('\n[codex-bridge] shutting down…')
  apiServer.close()
  adminServer.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
