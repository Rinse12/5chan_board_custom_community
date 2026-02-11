import { describe, it, expect } from 'vitest'
import { parseCliConfig } from './cli-config.js'

describe('parseCliConfig', () => {
  const emptyEnv: Record<string, string | undefined> = {}

  it('resolves --rpc-url from CLI flag', () => {
    const config = parseCliConfig(['board.eth', '--rpc-url', 'ws://cli:9138'], emptyEnv)
    expect(config.rpcUrl).toBe('ws://cli:9138')
  })

  it('falls back to PLEBBIT_RPC_WS_URL env var when flag not provided', () => {
    const config = parseCliConfig(['board.eth'], { PLEBBIT_RPC_WS_URL: 'ws://env:9138' })
    expect(config.rpcUrl).toBe('ws://env:9138')
  })

  it('CLI flag overrides env var for rpc-url', () => {
    const config = parseCliConfig(
      ['board.eth', '--rpc-url', 'ws://cli:9138'],
      { PLEBBIT_RPC_WS_URL: 'ws://env:9138' },
    )
    expect(config.rpcUrl).toBe('ws://cli:9138')
  })

  it('rpcUrl is undefined when neither flag nor env var is set', () => {
    const config = parseCliConfig(['board.eth'], emptyEnv)
    expect(config.rpcUrl).toBeUndefined()
  })

  it('resolves subplebbitAddress from first positional', () => {
    const config = parseCliConfig(['my-board.eth'], emptyEnv)
    expect(config.subplebbitAddress).toBe('my-board.eth')
  })

  it('subplebbitAddress is undefined when no positionals given', () => {
    const config = parseCliConfig([], emptyEnv)
    expect(config.subplebbitAddress).toBeUndefined()
  })

  it('uses default values when no flags or env vars provided', () => {
    const config = parseCliConfig(['board.eth'], emptyEnv)
    expect(config.perPage).toBe(15)
    expect(config.pages).toBe(10)
    expect(config.bumpLimit).toBe(300)
    expect(config.archivePurgeSeconds).toBe(172800)
    expect(config.statePath).toBeUndefined()
  })

  it('CLI flags override env vars for all options', () => {
    const config = parseCliConfig(
      [
        'board.eth',
        '--per-page', '25',
        '--pages', '5',
        '--bump-limit', '500',
        '--archive-purge-seconds', '86400',
        '--state-path', '/cli/path',
      ],
      {
        PER_PAGE: '10',
        PAGES: '3',
        BUMP_LIMIT: '100',
        ARCHIVE_PURGE_SECONDS: '3600',
        ARCHIVER_STATE_PATH: '/env/path',
      },
    )
    expect(config.perPage).toBe(25)
    expect(config.pages).toBe(5)
    expect(config.bumpLimit).toBe(500)
    expect(config.archivePurgeSeconds).toBe(86400)
    expect(config.statePath).toBe('/cli/path')
  })

  it('falls back to env vars when CLI flags not provided', () => {
    const config = parseCliConfig(['board.eth'], {
      PER_PAGE: '20',
      PAGES: '8',
      BUMP_LIMIT: '200',
      ARCHIVE_PURGE_SECONDS: '7200',
      ARCHIVER_STATE_PATH: '/env/state',
    })
    expect(config.perPage).toBe(20)
    expect(config.pages).toBe(8)
    expect(config.bumpLimit).toBe(200)
    expect(config.archivePurgeSeconds).toBe(7200)
    expect(config.statePath).toBe('/env/state')
  })
})
