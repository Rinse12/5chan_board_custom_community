import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadState, saveState, defaultStateDir } from './state.js'
import type { ArchiverState } from './types.js'

describe('state', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archiver-test-'))
    statePath = join(dir, 'state.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('loadState', () => {
    it('returns default state when file does not exist', () => {
      const state = loadState(statePath)
      expect(state).toEqual({ signers: {}, archivedThreads: {} })
    })

    it('loads existing state from file', () => {
      const existing: ArchiverState = {
        signers: { 'sub1.eth': { privateKey: 'pk123' } },
        archivedThreads: { 'Qm123': { archivedTimestamp: 1000 } },
      }
      saveState(statePath, existing)
      const loaded = loadState(statePath)
      expect(loaded).toEqual(existing)
    })

    it('returns default state when file contains invalid JSON', async () => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(statePath, 'not json')
      const state = loadState(statePath)
      expect(state).toEqual({ signers: {}, archivedThreads: {} })
    })
  })

  describe('saveState', () => {
    it('writes state as JSON', () => {
      const state: ArchiverState = {
        signers: { 'board.eth': { privateKey: 'abc' } },
        archivedThreads: {},
      }
      saveState(statePath, state)
      const raw = readFileSync(statePath, 'utf-8')
      expect(JSON.parse(raw)).toEqual(state)
    })

    it('overwrites previous state', () => {
      const state1: ArchiverState = {
        signers: {},
        archivedThreads: { 'Qm1': { archivedTimestamp: 100 } },
      }
      saveState(statePath, state1)

      const state2: ArchiverState = {
        signers: {},
        archivedThreads: { 'Qm2': { archivedTimestamp: 200 } },
      }
      saveState(statePath, state2)

      const loaded = loadState(statePath)
      expect(loaded).toEqual(state2)
      expect(loaded.archivedThreads['Qm1']).toBeUndefined()
    })

    it('preserves both signers and archivedThreads', () => {
      const state: ArchiverState = {
        signers: {
          'sub1.eth': { privateKey: 'key1' },
          'sub2.eth': { privateKey: 'key2' },
        },
        archivedThreads: {
          'QmA': { archivedTimestamp: 1000 },
          'QmB': { archivedTimestamp: 2000 },
        },
      }
      saveState(statePath, state)
      const loaded = loadState(statePath)
      expect(loaded.signers).toEqual(state.signers)
      expect(loaded.archivedThreads).toEqual(state.archivedThreads)
    })

    it('auto-creates missing parent directories', () => {
      const nestedPath = join(dir, 'a', 'b', 'c', 'state.json')
      const state: ArchiverState = { signers: {}, archivedThreads: {} }
      saveState(nestedPath, state)

      expect(existsSync(nestedPath)).toBe(true)
      const loaded = loadState(nestedPath)
      expect(loaded).toEqual(state)
    })
  })

  describe('defaultStateDir', () => {
    it('returns a directory path under 5chan-archiver data dir', () => {
      const dir = defaultStateDir()
      expect(dir).toMatch(/5chan-archiver/)
      expect(dir).toMatch(/5chan_archiver_states$/)
    })
  })
})
