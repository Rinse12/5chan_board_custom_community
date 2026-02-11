#!/usr/bin/env node

import { parseArgs } from 'node:util'
import Plebbit from '@plebbit/plebbit-js'
import { startArchiver } from './archiver.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'per-page': { type: 'string' },
    'pages': { type: 'string' },
    'bump-limit': { type: 'string' },
    'archive-purge-seconds': { type: 'string' },
    'state-path': { type: 'string' },
  },
})

const subplebbitAddress = positionals[0]
if (!subplebbitAddress) {
  console.error('Usage: 5chan-archiver <subplebbit-address> [--per-page N] [--pages N] [--bump-limit N] [--archive-purge-seconds N] [--state-path PATH]')
  process.exit(1)
}

const rpcUrl = process.env.PLEBBIT_RPC_WS_URL
if (!rpcUrl) {
  console.error('Error: PLEBBIT_RPC_WS_URL environment variable is required')
  process.exit(1)
}

const perPage = parseInt(values['per-page'] ?? process.env.PER_PAGE ?? '15', 10)
const pages = parseInt(values['pages'] ?? process.env.PAGES ?? '10', 10)
const bumpLimit = parseInt(values['bump-limit'] ?? process.env.BUMP_LIMIT ?? '300', 10)
const archivePurgeSeconds = parseInt(values['archive-purge-seconds'] ?? process.env.ARCHIVE_PURGE_SECONDS ?? '172800', 10)
const statePath = values['state-path'] ?? process.env.ARCHIVER_STATE_PATH ?? undefined

const plebbit = await Plebbit({
  plebbitRpcClientsOptions: [rpcUrl],
})

const archiver = startArchiver({
  subplebbitAddress,
  plebbit,
  statePath,
  perPage,
  pages,
  bumpLimit,
  archivePurgeSeconds,
})

process.on('SIGINT', async () => {
  await archiver.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await archiver.stop()
  process.exit(0)
})
