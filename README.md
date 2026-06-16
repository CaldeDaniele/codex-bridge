# codex-bridge

Standalone HTTP gateway that runs **on a host** (a customer VM / machine) next to a
local [`codex app-server`](https://github.com/openai/codex/tree/main/codex-rs/app-server)
and makes it look like the Cursor remote-agent API. The **digital-concierge**
dashboard's *codex-runner* integration talks to this bridge over HTTPS; the bridge
wraps codex's JSON-RPC-over-stdio protocol and drives it.

```
dashboard (codex-runner integration)  ──HTTPS+Bearer──►  codex-bridge  ──stdio JSON-RPC──►  codex app-server
        launch / status / followup / cancel              (this repo)        thread/start · turn/start · …
```

It ships as a **one-click, self-contained executable** for Windows, macOS and Linux
(no Node, no install). On first launch it generates its own config (including a strong
API key) and opens a small **local web GUI** where you set the repos and policy. It is a
**separate project** from the dashboard on purpose: it is deployed on each client machine
that wants this capability, not bundled with the dashboard.

---

## Quick start (one-click)

1. **Download** the binary for your OS from the [**Releases**](../../releases/latest) page:

   | OS / arch | file |
   |---|---|
   | macOS (Apple Silicon) | `codex-bridge-macos-arm64` |
   | macOS (Intel) | `codex-bridge-macos-x64` |
   | Linux x86-64 | `codex-bridge-linux-x64` |
   | Linux arm64 | `codex-bridge-linux-arm64` |
   | Windows x64 | `codex-bridge-windows-x64.exe` |

2. **Run it** (double-click, or from a terminal):
   - **macOS** — first time, the OS quarantines downloaded binaries. Either right-click → **Open**,
     or clear the flag: `xattr -dr com.apple.quarantine ./codex-bridge-macos-arm64` then
     `chmod +x ./codex-bridge-macos-arm64 && ./codex-bridge-macos-arm64`.
   - **Linux** — `chmod +x ./codex-bridge-linux-x64 && ./codex-bridge-linux-x64`.
   - **Windows** — double-click. SmartScreen may warn about an unsigned app → **More info → Run anyway**.

3. **First launch** auto-generates a config file with a fresh `CODEX_BRIDGE_API_KEY`,
   starts the API on `127.0.0.1:8787`, and **opens the config page** in your browser
   (`http://127.0.0.1:8788`). Add at least one repository there, copy the API key, then
   wire it into the dashboard's **codex-runner** integration (bridge URL + key + the same repo `url`s).

The process stays running in its console window; **Ctrl-C** (or closing the window) stops it.
Requires the `codex` CLI installed on `PATH` and authenticated to OpenAI on this machine.

---

## The config GUI

The bridge serves a local admin page on its own **loopback-only** port (`8788` by default,
**never** put it behind the public TLS proxy). From there you can view and edit everything
without touching files:

- **API key** — reveal / copy / **regenerate** (the dashboard must be updated when you regenerate).
- **Repositories** — the allowlist of `{ url, path }`. `url` is the label the dashboard sends
  (e.g. `github.com/acme/repo`); `path` is the **absolute** local checkout used as codex's `cwd`
  (`/Users/me/code/repo`, `/srv/repos/repo`, or `C:\Users\me\code\repo` on Windows). Use the
  **Browse…** button to pick the folder from a server-side directory picker — a browser can't
  hand a web page an absolute filesystem path, so the bridge lists directories itself (loopback,
  same guards as the rest of the admin API). Non-existent paths are flagged on save.
- **Execution policy** — `sandbox`, `approvalPolicy`, `autoApprove`, default `model`.
- **Network & advanced** — API host/port, admin port, codex binary, audit-log path, request log, debug, admin token.
- **Activity log** — a live panel (top of the page) showing the most recent requests, codex
  actions (audit), and errors, with a kind filter and follow/pause. See below.

Most changes apply **live** (repos, policy, key). Changing **host / port / admin port**
needs a restart — the page tells you when.

**Why it's safe by default.** The admin page can set `sandbox=danger-full-access` (i.e. it controls
remote code execution), so it is hardened:

- bound to `127.0.0.1` only;
- the `Host` header must be a loopback literal → defeats DNS-rebinding attacks;
- mutations require an `x-codex-bridge-admin` header a cross-site page can't set → defeats CSRF;
- optionally set **`CODEX_BRIDGE_ADMIN_TOKEN`** to require a bearer token on the admin API too
  (recommended on shared / multi-user machines).

---

## Configuration

Settings live in a JSON file the GUI reads and writes. You normally never edit it by hand.

**File location** (override with `CODEX_BRIDGE_CONFIG=/path/to/config.json`):

| OS | path |
|---|---|
| macOS | `~/Library/Application Support/codex-bridge/config.json` |
| Linux | `$XDG_CONFIG_HOME/codex-bridge/config.json` (default `~/.config/...`) |
| Windows | `%APPDATA%\codex-bridge\config.json` |

The file is written with `0600` perms (owner-only) since it holds the API key.

**Precedence: `defaults` < `config.json` < environment.** Environment variables always win,
so existing headless/`.env` deployments keep behaving exactly as before — and in the GUI any
value coming from the environment is shown **read-only** (`from env`).

> ⚠️ The binary also auto-loads a **`.env` file in its working directory** (Bun behavior). Those
> values count as "environment" and override the config file. Don't leave a stray `.env` next to
> the binary unless you mean it.

### Variables

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_BRIDGE_API_KEY` | *(auto-generated)* | Bearer key the dashboard must send. ≥16 chars; a 32-byte hex is minted on first run. |
| `CODEX_BRIDGE_REPOS` | `[]` | JSON array of `{ "url", "path" }`. The repo allowlist (also editable in the GUI). |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | API bind address. Keep on localhost; put a TLS proxy in front. *(restart)* |
| `CODEX_BRIDGE_PORT` | `8787` | API port. *(restart)* |
| `CODEX_BRIDGE_ADMIN_PORT` | `8788` | Admin GUI port (loopback only). *(restart)* |
| `CODEX_BRIDGE_ADMIN_TOKEN` | *(none)* | If set, the admin API requires `Authorization: Bearer <token>`. |
| `CODEX_APPROVAL_POLICY` | `never` | `never` (auto-approve), `on-request`, `untrusted`, or `config` (defer to `~/.codex/config.toml`). |
| `CODEX_SANDBOX` | `workspace-write` | `read-only`, `workspace-write`, `danger-full-access`, or `config`. (Legacy camelCase like `workspaceWrite` is still accepted and normalized.) |
| `CODEX_AUTO_APPROVE` | `true` | Defensive net for stray approval requests; `false` declines all. |
| `CODEX_MODEL` | *(codex default)* | Default model id for launches. |
| `CODEX_BIN` | `codex` | Path to the codex binary. |
| `CODEX_BRIDGE_REQUEST_LOG` | `true` | Log one line per HTTP request (API + admin) to stdout. `false`/`0` disables. |
| `CODEX_BRIDGE_REQUEST_LOG_FILE` | *(stdout only)* | Optional JSONL access-log file for requests. |
| `CODEX_BRIDGE_AUDIT_LOG` | *(stdout only)* | Optional JSONL audit-log file path (codex launch/followup/cancel/approval). |
| `CODEX_BRIDGE_DEBUG` | `false` | `1` logs every raw codex notification (use when adapting to a new codex version). |
| `CODEX_BRIDGE_CONFIG` | *(per-OS path)* | Override the config-file location. |
| `CODEX_BRIDGE_NO_OPEN` | *(unset)* | `1` (or `--no-open`) suppresses auto-opening the browser. `--open` forces it. |

### Logging & monitoring

The quickest place to watch activity is the **Activity log** panel at the top of the GUI: it
streams the most recent ~500 events (requests, codex audit actions, errors) live, with a kind
filter and follow/pause. It's an in-memory tail — for full history, use stdout or a log file below.

Under the hood there are two independent logs, both on stdout by default:

- **Request log** (`CODEX_BRIDGE_REQUEST_LOG`, on by default) — one line per finished HTTP
  request, on both the API and admin servers, so you can watch what reaches the bridge:

  ```
  [codex-bridge][req] api   127.0.0.1 POST /v1/agents 200 142ms
  [codex-bridge][req] admin 127.0.0.1 PUT  /api/config 200 1ms
  ```

  It logs `server · ip · method · path · status · duration` only — **never** the `Authorization`
  header or the query string, so bearer tokens can't leak into the log. The pure poll endpoints
  (`/v1/healthz`, `/api/status`) are skipped to keep it readable. Set
  `CODEX_BRIDGE_REQUEST_LOG_FILE` to also append each request as JSONL.

- **Audit log** (`CODEX_BRIDGE_AUDIT_LOG`) — the higher-level codex actions
  (launch / followup / cancel / approval-accepted / approval-declined), with repo and cwd.

Both are toggleable from the GUI (Request log) and via environment.

### Headless / server use

No desktop? Run it the same way; it still works. Either pre-create the config file, or set the
variables in the environment (the values become read-only overrides). Auto-open is skipped when
there's no browser available, and you can force it off with `CODEX_BRIDGE_NO_OPEN=1`. To reach the
GUI on a headless box, SSH-tunnel the admin port: `ssh -L 8788:127.0.0.1:8788 user@host`.

---

## Security (read before exposing)

This process can run arbitrary commands on this machine via codex. Treat it as such:

1. **TLS only.** The API binds `127.0.0.1` by default; put nginx/caddy in front for TLS.
   Never expose the raw API port to the internet. The admin port is loopback-only — don't proxy it.
2. **Strong key.** `CODEX_BRIDGE_API_KEY` ≥ 16 chars (32-byte hex default). Compared in constant time.
   Rotate from the GUI (**Regenerate**) and update the dashboard.
3. **Repo allowlist is the boundary.** Only paths in the repo list are ever used as codex `cwd`.
   Requests for other repos get 403.
4. **Sandbox** (below). Defaults to `workspace-write` + `approvalPolicy=never`.
5. **Least privilege.** Run as a dedicated low-privilege user, ideally in a VM/container with
   restricted network egress.
6. **Audit.** Every launch / followup / cancel / approval is logged (stdout, and to
   `CODEX_BRIDGE_AUDIT_LOG` if set).

### Scoping codex: free within a folder vs full machine

Two independent knobs (both editable in the GUI):

- **`CODEX_SANDBOX`** — what codex may touch: `read-only`, `workspace-write` (default), `danger-full-access`.
- **`CODEX_APPROVAL_POLICY`** — whether it pauses for approval: `never` (default), `on-request`, `untrusted`.

**"Work freely, but locked to a folder" → `workspace-write` + `never` (the default).** codex reads
the machine but only **writes and runs effectful commands inside the repo `path`** (its `cwd`). The
lock is enforced twice: the bridge allowlist *and* codex's own sandbox. In `workspace-write`, network
is **off** and only the workspace is writable by default; tune via `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
network_access = true                       # allow installs / git push / fetching deps
writable_roots = ["/home/me/another-dir"]   # extra writable folders
```

To let codex do **anything**, set `CODEX_SANDBOX=danger-full-access` (or set both knobs to `config`
and put `sandbox_mode = "danger-full-access"` in `~/.codex/config.toml`). ⚠️ This removes all
filesystem/network boundaries; combined with the bridge being reachable, anyone with the API key
gets full remote code execution on this host.

---

## HTTP API (Cursor-shaped)

| Method & path | Purpose | codex call |
|---|---|---|
| `GET /v1/healthz` | liveness (no auth) | — |
| `GET /v1/me` | validate key + codex version | — |
| `POST /v1/agents` | launch: `{prompt:{text}, repos:[{url}], model?:{id}}` | `thread/start` + `turn/start` |
| `POST /v1/agents/:id/runs` | follow-up: `{prompt:{text}}` | `turn/start` on same thread |
| `GET /v1/agents/:id/runs/:runId` | run status + assembled result | (in-memory turn state) |
| `GET /v1/agents/:id` | `{repos:[{url}]}` for the allowlist guard | — |
| `POST /v1/agents/:id/cancel` | `{runId}` → interrupt | `turn/interrupt` |

`agentId` = codex `threadId`, `runId` = codex `turnId`.

### ⚠️ Protocol drift

Method/param/notification field names are pinned to the documented codex app-server protocol.
codex moves fast — after upgrading it, re-verify against your installed version. Run with
`CODEX_BRIDGE_DEBUG=1` to log every raw notification so you can adjust `handleNotification()` /
item field extraction in `src/server.mjs` and `src/codex-client.mjs`. Run state is **in memory**:
restarting the bridge drops in-flight runs (the dashboard poll then times out gracefully).

---

## Building from source

The binaries are produced with **[Bun](https://bun.sh)** (`bun build --compile`), which embeds the
runtime and bundles all modules — so each output is a single self-contained executable and the
**client needs neither Bun nor Node**. Bun compiles the ESM source directly (this is why we no longer
need the old hand-rolled CJS/SEA bundling step).

**Prerequisite:** Bun ≥ 1.1 on the *build* machine. Install: `curl -fsSL https://bun.sh/install | bash`.

```bash
# All five OS/arch binaries -> dist/   (cross-compiled from one machine;
# Bun downloads each target runtime on first use)
bun run build:binaries

# A subset
bun run scripts/build-binaries.mjs macos-arm64 linux-x64
```

Output (sizes approximate; `--minify` is applied):

```
dist/codex-bridge-macos-arm64       (~58 MB)
dist/codex-bridge-macos-x64         (~62 MB)
dist/codex-bridge-linux-x64         (~98 MB)
dist/codex-bridge-linux-arm64       (~95 MB)
dist/codex-bridge-windows-x64.exe   (~109 MB)
```

Cross-compile targets are defined in [`scripts/build-binaries.mjs`](scripts/build-binaries.mjs)
(map of label → Bun `--target`). To add/remove an OS/arch, edit that map.

### Publishing a release (binaries as Release assets)

The binaries are **not** committed to the repo (they're gitignored — a single `.exe` exceeds
GitHub's 100 MB file limit and they'd bloat history forever). They're published as **Release
assets** instead, which is also where users download them. A GitHub Actions workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)) does this automatically:
push a version tag and it cross-compiles all targets and attaches them to the release.

```bash
git tag v0.1.0
git push origin v0.1.0      # -> CI builds + creates the Release with all binaries
```

To cut a release locally instead (using the binaries already in `dist/`):

```bash
bun run build:binaries && bun run build
gh release create v0.1.0 --generate-notes \
  dist/codex-bridge-macos-arm64 dist/codex-bridge-macos-x64 \
  dist/codex-bridge-linux-x64 dist/codex-bridge-linux-arm64 \
  dist/codex-bridge-windows-x64.exe dist/codex-bridge.mjs
```

### Node fallback (no Bun on the client, but Node ≥ 20.6 present)

If you'd rather ship a tiny script than a ~60–110 MB binary, build the single-file bundle and run
it with Node:

```bash
bun run build            # -> dist/codex-bridge.mjs  (~43 KB, zero deps)
node dist/codex-bridge.mjs
```

(The bundle is produced with Bun for convenience, but only Node ≥ 20.6 is needed to *run* it.)

### Running from a source checkout (dev)

```bash
bun src/server.mjs        # npm start
# or, with Node ≥ 20.6:
node --env-file-if-exists=.env src/server.mjs   # npm run start:node
```

### Signing (not done here)

The binaries are **unsigned**, hence the macOS Gatekeeper / Windows SmartScreen prompts above.
Code-signing + notarization (macOS) and Authenticode (Windows) are a separate, credential-bearing
step — add them in CI if you distribute widely.

---

## Layout

```
src/server.mjs        HTTP gateway, auth, allowlist, sandbox policy, audit, turn state, boot
src/codex-client.mjs  JSON-RPC client for `codex app-server` over stdio
src/config.mjs        config file (per-OS), env-override precedence, first-run key generation
src/admin-ui.mjs      loopback-only config/status GUI (self-contained page + JSON API)
scripts/build-binaries.mjs   Bun cross-compile of the five OS/arch executables
.env.example          configuration template (optional; the GUI replaces hand-editing)
```

TODO before distributing externally: pin a tested codex version, sign the binaries.

## License

[MIT](LICENSE) — free to use, modify and redistribute; keep the copyright notice. No warranty.
