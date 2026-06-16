// codex-bridge/codex-client.mjs
//
// Thin JSON-RPC 2.0 client for `codex app-server` over stdio (newline-delimited
// JSON). Zero npm dependencies — built-ins only. Handles the initialize
// handshake, request/response correlation, server→client approval requests, and
// re-emits all notifications so the HTTP layer can accumulate turn state.
//
// ⚠️ The codex app-server protocol moves fast. Method/param/notification field
// names here are pinned to the documented protocol (initialize, thread/start,
// turn/start, turn/interrupt, item/* notifications). If you upgrade codex,
// re-verify against your installed version — run with CODEX_BRIDGE_DEBUG=1 to
// log every raw notification.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

export class CodexAppServerClient extends EventEmitter {
  #proc = null
  #rl = null
  #nextId = 1
  #pending = new Map() // id -> { resolve, reject }
  #ready = null
  #opts

  constructor(opts = {}) {
    super()
    this.#opts = {
      command: opts.command || process.env.CODEX_BIN || 'codex',
      args: opts.args || ['app-server'],
      env: opts.env || process.env,
      // (method, params) => 'accept' | 'acceptForSession' | 'decline' | 'cancel'
      onApproval: opts.onApproval || (() => 'accept'),
      log: opts.log || console,
      debug: opts.debug ?? process.env.CODEX_BRIDGE_DEBUG === '1',
    }
  }

  async start() {
    if (this.#ready) return this.#ready
    this.#ready = this.#startInternal()
    return this.#ready
  }

  async #startInternal() {
    const { command, args, env, log } = this.#opts
    log.info?.(`[codex-client] spawning: ${command} ${args.join(' ')}`)
    this.#proc = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#proc.on('error', (err) => {
      log.error?.(`[codex-client] failed to spawn codex: ${err?.message || err}`)
    })
    this.#proc.on('exit', (code, signal) => {
      log.error?.(`[codex-client] app-server exited code=${code} signal=${signal}`)
      const err = new Error(`codex app-server exited (code=${code})`)
      for (const { reject } of this.#pending.values()) reject(err)
      this.#pending.clear()
      this.#proc = null
      this.#ready = null
      this.emit('exit', { code, signal })
    })
    this.#proc.stderr.on('data', (d) => log.warn?.(`[codex-client][stderr] ${String(d).trim()}`))

    this.#rl = createInterface({ input: this.#proc.stdout })
    this.#rl.on('line', (line) => this.#onLine(line))

    await this.request('initialize', {
      clientInfo: { name: 'codex-bridge', title: 'Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.#notify('initialized', {})
    log.info?.('[codex-client] initialized')
  }

  #onLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.#opts.log.warn?.(`[codex-client] non-JSON line: ${trimmed.slice(0, 200)}`)
      return
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id)
      this.#pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error?.message || JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }

    // Server → client request (approval flows).
    if (msg.id !== undefined && msg.method) {
      this.#handleServerRequest(msg)
      return
    }

    // Notification.
    if (msg.method) {
      if (this.#opts.debug) this.#opts.log.info?.(`[codex-client][notif] ${msg.method} ${JSON.stringify(msg.params)}`)
      this.emit('notification', msg.method, msg.params || {})
    }
  }

  async #handleServerRequest(msg) {
    try {
      let result = {}
      if (
        msg.method === 'item/commandExecution/requestApproval' ||
        msg.method === 'item/fileChange/requestApproval'
      ) {
        const decision = await this.#opts.onApproval(msg.method, msg.params || {})
        result = { decision }
      }
      this.#send({ jsonrpc: '2.0', id: msg.id, result })
    } catch (e) {
      this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e?.message || e) } })
    }
  }

  request(method, params) {
    if (!this.#proc) return Promise.reject(new Error('codex app-server not running'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#send({ jsonrpc: '2.0', id, method, params: params || {} })
      } catch (e) {
        this.#pending.delete(id)
        reject(e)
      }
    })
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params: params || {} })
  }

  #send(obj) {
    if (!this.#proc?.stdin?.writable) throw new Error('codex app-server stdin not writable')
    this.#proc.stdin.write(JSON.stringify(obj) + '\n')
  }
}
