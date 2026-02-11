#!/usr/bin/env node

import { startArchiver } from './archiver.js'
import { parseCliConfig } from './cli-config.js'

const config = parseCliConfig(process.argv.slice(2), process.env)

if (!config.subplebbitAddress) {
  console.error('Usage: 5chan-archiver <subplebbit-address> [--rpc-url URL] [--per-page N] [--pages N] [--bump-limit N] [--archive-purge-seconds N] [--state-path PATH]')
  process.exit(1)
}

const archiver = await startArchiver({
  subplebbitAddress: config.subplebbitAddress,
  plebbitRpcUrl: config.rpcUrl,
  statePath: config.statePath,
  perPage: config.perPage,
  pages: config.pages,
  bumpLimit: config.bumpLimit,
  archivePurgeSeconds: config.archivePurgeSeconds,
})

process.on('SIGINT', async () => {
  await archiver.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await archiver.stop()
  process.exit(0)
})
