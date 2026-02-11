#!/usr/bin/env node

import Plebbit from '@plebbit/plebbit-js'
import { startArchiver } from './archiver.js'
import { parseCliConfig } from './cli-config.js'

const config = parseCliConfig(process.argv.slice(2), process.env)

if (!config.subplebbitAddress) {
  console.error('Usage: 5chan-archiver <subplebbit-address> [--rpc-url URL] [--per-page N] [--pages N] [--bump-limit N] [--archive-purge-seconds N] [--state-path PATH]')
  process.exit(1)
}

if (!config.rpcUrl) {
  console.error('Error: PLEBBIT_RPC_WS_URL is required (set via --rpc-url or PLEBBIT_RPC_WS_URL env var)')
  process.exit(1)
}

const plebbit = await Plebbit({
  plebbitRpcClientsOptions: [config.rpcUrl],
})

const archiver = startArchiver({
  subplebbitAddress: config.subplebbitAddress,
  plebbit,
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
