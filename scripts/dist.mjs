import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// GitHub release hosts are unreachable on some networks; pin the npmmirror binaries.
process.env.ELECTRON_MIRROR ??= 'https://cdn.npmmirror.com/binaries/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/'

const cli = fileURLToPath(new URL('../node_modules/electron-builder/cli.js', import.meta.url))
const args = process.argv.slice(2)
const r = spawnSync(process.execPath, [cli, ...(args.length ? args : ['--win', 'nsis'])], { stdio: 'inherit', env: process.env })
process.exit(r.status ?? 1)