// scripts/build-binaries.mjs
//
// Cross-compile the codex-bridge one-click executables with Bun. Run with Bun
// (the binaries are self-contained: the client needs neither Bun nor Node):
//
//   bun run scripts/build-binaries.mjs            # all targets
//   bun run scripts/build-binaries.mjs macos-arm64 linux-x64   # a subset
//
// Each target embeds the Bun runtime, so `bun build --compile` produces a single
// native executable per OS/arch.

import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src', 'server.mjs')
const OUT_DIR = join(ROOT, 'dist')

// label -> { bunTarget, outfile }
const TARGETS = {
  'macos-arm64': { bunTarget: 'bun-darwin-arm64', outfile: 'codex-bridge-macos-arm64' },
  'macos-x64': { bunTarget: 'bun-darwin-x64', outfile: 'codex-bridge-macos-x64' },
  'linux-x64': { bunTarget: 'bun-linux-x64', outfile: 'codex-bridge-linux-x64' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', outfile: 'codex-bridge-linux-arm64' },
  'windows-x64': { bunTarget: 'bun-windows-x64', outfile: 'codex-bridge-windows-x64.exe' },
}

const requested = process.argv.slice(2)
const labels = requested.length ? requested : Object.keys(TARGETS)

const unknown = labels.filter((l) => !TARGETS[l])
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}`)
  console.error(`Valid targets: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

console.log(`Building ${labels.length} target(s) from ${ENTRY}\n`)
const built = []
for (const label of labels) {
  const { bunTarget, outfile } = TARGETS[label]
  const out = join(OUT_DIR, outfile)
  process.stdout.write(`→ ${label.padEnd(13)} (${bunTarget}) … `)
  try {
    execFileSync(
      'bun',
      ['build', ENTRY, '--compile', `--target=${bunTarget}`, '--outfile', out, '--minify'],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    const mb = (statSync(out).size / 1024 / 1024).toFixed(1)
    console.log(`ok  (${mb} MB)  dist/${outfile}`)
    built.push(outfile)
  } catch (e) {
    console.log('FAILED')
    console.error(e.message)
    process.exit(1)
  }
}

console.log(`\nDone. ${built.length} binary(ies) in dist/:`)
for (const f of built) console.log(`  dist/${f}`)
