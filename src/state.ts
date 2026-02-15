import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import envPaths from 'env-paths'
import type { ArchiverState } from './types.js'

const DEFAULT_STATE: ArchiverState = {
  signers: {},
  lockedThreads: {},
}

export function defaultStateDir(): string {
  return join(envPaths('5chan-archiver').data, '5chan_archiver_states')
}

export function loadState(path: string): ArchiverState {
  try {
    const data = readFileSync(path, 'utf-8')
    return JSON.parse(data) as ArchiverState
  } catch {
    return structuredClone(DEFAULT_STATE)
  }
}

export function saveState(path: string, state: ArchiverState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
