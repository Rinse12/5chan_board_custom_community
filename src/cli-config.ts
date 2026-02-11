import { parseArgs } from 'node:util'

export interface CliConfig {
  subplebbitAddress: string | undefined
  rpcUrl: string | undefined
  perPage: number
  pages: number
  bumpLimit: number
  archivePurgeSeconds: number
  statePath: string | undefined
}

export function parseCliConfig(args: string[], env: Record<string, string | undefined>): CliConfig {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      // WebSocket URL of the Plebbit RPC server
      'rpc-url': { type: 'string' },
      'per-page': { type: 'string' },
      'pages': { type: 'string' },
      'bump-limit': { type: 'string' },
      'archive-purge-seconds': { type: 'string' },
      'state-path': { type: 'string' },
    },
  })

  const subplebbitAddress = positionals[0]
  const rpcUrl = values['rpc-url'] ?? env.PLEBBIT_RPC_WS_URL
  const perPage = parseInt(values['per-page'] ?? env.PER_PAGE ?? '15', 10)
  const pages = parseInt(values['pages'] ?? env.PAGES ?? '10', 10)
  const bumpLimit = parseInt(values['bump-limit'] ?? env.BUMP_LIMIT ?? '300', 10)
  const archivePurgeSeconds = parseInt(values['archive-purge-seconds'] ?? env.ARCHIVE_PURGE_SECONDS ?? '172800', 10)
  const statePath = values['state-path'] ?? env.ARCHIVER_STATE_PATH ?? undefined

  return { subplebbitAddress, rpcUrl, perPage, pages, bumpLimit, archivePurgeSeconds, statePath }
}
