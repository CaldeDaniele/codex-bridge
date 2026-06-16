// codex-bridge/config.mjs
//
// Configuration layer for the one-click distributable. Loads settings from a
// per-OS JSON file, auto-generates a strong CODEX_BRIDGE_API_KEY on first run,
// and lets the admin UI persist changes at runtime. Zero npm dependencies.
//
// Precedence (lowest to highest):   defaults  <  config.json  <  environment
//
// Environment variables always win so existing headless / .env deployments keep
// behaving exactly as before; the admin UI shows env-sourced values as
// read-only ("overridden by environment").

import { randomBytes } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------- schema ----------
// Each key maps to an env var, a default, and a coercion for env strings.
// `secret: true` => masked in the admin API.   `restart: true` => host/port-like,
// needs a process restart to take effect.
const SCHEMA = {
  apiKey: { env: 'CODEX_BRIDGE_API_KEY', def: '', type: 'string', secret: true },
  repos: { env: 'CODEX_BRIDGE_REPOS', def: [], type: 'json' },
  host: { env: 'CODEX_BRIDGE_HOST', def: '127.0.0.1', type: 'string', restart: true },
  port: { env: 'CODEX_BRIDGE_PORT', def: 8787, type: 'number', restart: true },
  adminPort: { env: 'CODEX_BRIDGE_ADMIN_PORT', def: 8788, type: 'number', restart: true },
  adminToken: { env: 'CODEX_BRIDGE_ADMIN_TOKEN', def: '', type: 'string', secret: true },
  approvalPolicy: { env: 'CODEX_APPROVAL_POLICY', def: 'never', type: 'string' },
  sandbox: { env: 'CODEX_SANDBOX', def: 'workspace-write', type: 'string' },
  autoApprove: { env: 'CODEX_AUTO_APPROVE', def: true, type: 'bool' },
  auditLog: { env: 'CODEX_BRIDGE_AUDIT_LOG', def: '', type: 'string' },
  model: { env: 'CODEX_MODEL', def: '', type: 'string' },
  codexBin: { env: 'CODEX_BIN', def: 'codex', type: 'string' },
  requestLog: { env: 'CODEX_BRIDGE_REQUEST_LOG', def: true, type: 'bool' },
  requestLogFile: { env: 'CODEX_BRIDGE_REQUEST_LOG_FILE', def: '', type: 'string' },
  debug: { env: 'CODEX_BRIDGE_DEBUG', def: false, type: 'bool' },
}

export const CONFIG_KEYS = Object.keys(SCHEMA)

function coerce(type, raw) {
  switch (type) {
    case 'number': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    case 'bool':
      // CODEX_AUTO_APPROVE historically meant "anything except the literal false".
      return !(String(raw).toLowerCase() === 'false' || String(raw) === '0' || String(raw) === '')
    case 'json':
      try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw
        return Array.isArray(v) ? v : undefined
      } catch {
        return undefined
      }
    default:
      return String(raw)
  }
}

/**
 * Map any accepted sandbox spelling to the kebab-case variant codex app-server
 * expects (read-only / workspace-write / danger-full-access). Historical camelCase
 * values (readOnly / workspaceWrite / dangerFullAccess) and 'config' are accepted;
 * anything unknown is passed through so codex can report it.
 */
export function normalizeSandbox(v) {
  if (!v || v === 'config') return v
  const k = String(v).toLowerCase().replace(/[^a-z]/g, '')
  if (k === 'readonly') return 'read-only'
  if (k === 'workspacewrite') return 'workspace-write'
  if (k === 'dangerfullaccess') return 'danger-full-access'
  return v
}

/** Per-OS path for the config file (unless overridden by CODEX_BRIDGE_CONFIG). */
export function configFilePath() {
  if (process.env.CODEX_BRIDGE_CONFIG) return process.env.CODEX_BRIDGE_CONFIG
  const home = homedir()
  let base
  if (platform() === 'win32') base = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  else if (platform() === 'darwin') base = join(home, 'Library', 'Application Support')
  else base = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(base, 'codex-bridge', 'config.json')
}

function generateKey() {
  return randomBytes(32).toString('hex') // 64 hex chars
}

export class Config {
  #path
  #file = {} // values read from / written to config.json
  #env = {} // values present in the environment (override file)
  createdNow = false // true if load() created a fresh config file
  generatedKey = false // true if load() auto-generated the API key

  constructor(path = configFilePath()) {
    this.#path = path
  }

  get path() {
    return this.#path
  }

  /** Load env overrides + the config file, creating it (with a fresh key) on first run. */
  load() {
    // 1. environment overrides (only keys actually set)
    this.#env = {}
    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (process.env[spec.env] !== undefined && process.env[spec.env] !== '') {
        const v = coerce(spec.type, process.env[spec.env])
        if (v !== undefined) this.#env[key] = v
      }
    }

    // 2. config file
    if (existsSync(this.#path)) {
      try {
        this.#file = JSON.parse(readFileSync(this.#path, 'utf8')) || {}
      } catch (e) {
        throw new Error(`config file ${this.#path} is not valid JSON: ${e.message}`)
      }
    } else {
      this.#file = {}
      this.createdNow = true
    }

    // 3. first-run: mint an API key if none anywhere (file or env)
    if (!this.#file.apiKey && !this.#env.apiKey) {
      this.#file.apiKey = generateKey()
      this.generatedKey = true
    }

    if (this.createdNow || this.generatedKey) this.save()
    return this
  }

  /** Effective values: defaults < file < env. */
  get values() {
    const out = {}
    for (const [key, spec] of Object.entries(SCHEMA)) {
      out[key] = this.#env[key] ?? this.#file[key] ?? spec.def
    }
    // codex app-server expects kebab-case sandbox modes; normalize so the wire,
    // the GUI and status all agree regardless of how the value was written.
    out.sandbox = normalizeSandbox(out.sandbox)
    return out
  }

  /** True if this key's effective value comes from the environment (read-only in UI). */
  isEnvOverridden(key) {
    return key in this.#env
  }

  /**
   * Apply a partial update to the FILE layer and persist. Env-overridden keys are
   * ignored (the env still wins). Returns the list of keys that actually changed.
   */
  update(patch) {
    const changed = []
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in SCHEMA)) continue
      if (this.isEnvOverridden(key)) continue // env wins; don't pretend to change it
      const next = coerceForStore(SCHEMA[key].type, value)
      if (next === undefined) continue
      if (JSON.stringify(this.#file[key]) !== JSON.stringify(next)) {
        this.#file[key] = next
        changed.push(key)
      }
    }
    if (changed.length) this.save()
    return changed
  }

  regenerateKey() {
    if (this.isEnvOverridden('apiKey')) return null // can't override the env
    this.#file.apiKey = generateKey()
    this.save()
    return this.#file.apiKey
  }

  /** Whether a given key needs a restart to take effect. */
  needsRestart(key) {
    return !!SCHEMA[key]?.restart
  }

  isSecret(key) {
    return !!SCHEMA[key]?.secret
  }

  save() {
    mkdirSync(dirname(this.#path), { recursive: true })
    writeFileSync(this.#path, JSON.stringify(this.#file, null, 2) + '\n', { mode: 0o600 })
  }
}

/** Coerce a value coming from the admin API (already-typed JSON) into storage form. */
function coerceForStore(type, value) {
  switch (type) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
    case 'bool':
      return Boolean(value)
    case 'json':
      return Array.isArray(value) ? value : undefined
    default:
      return value == null ? '' : String(value)
  }
}
