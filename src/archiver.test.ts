import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadState, saveState, isPidAlive } from './state.js'
import type { ArchiverState, PlebbitInstance, Page, ThreadComment } from './types.js'
import Plebbit from '@plebbit/plebbit-js'
import { startArchiver } from './archiver.js'

vi.mock('@plebbit/plebbit-js')

// Helper to create a mock thread
function mockThread(cid: string, overrides: Record<string, unknown> = {}): ThreadComment {
  return { cid, pinned: false, locked: false, replyCount: 0, ...overrides } as unknown as ThreadComment
}

interface MockModerationRecord {
  commentCid: string
  commentModeration: { locked?: boolean; purged?: boolean }
  subplebbitAddress: string
  signer: { address: string; privateKey: string; type: 'ed25519' }
}

// Helper to create a mock plebbit instance (RPC-only, no dataPath)
function createMockPlebbit() {
  const mockSigner = { address: 'mock-address-123', privateKey: 'mock-pk-123' }
  const publishedModerations: MockModerationRecord[] = []

  const instance = {
    createSigner: vi.fn().mockResolvedValue({ ...mockSigner }),
    getSubplebbit: vi.fn(),
    subplebbits: [] as string[],
    createCommentModeration: vi.fn().mockImplementation((opts: MockModerationRecord) => ({
      ...opts,
      publish: vi.fn().mockImplementation(async () => {
        publishedModerations.push(opts)
      }),
    })),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlebbitInstance

  vi.mocked(Plebbit).mockResolvedValue(instance)

  return {
    instance,
    mockSigner,
    publishedModerations,
  }
}

// Helper to create a mock subplebbit with posts configuration
function createMockSubplebbit(postsConfig: {
  pageCids?: Partial<Record<string, string>>
  pages?: Partial<Record<string, Page>>
  getPage?: (args: { cid: string }) => Promise<Page>
}) {
  let updateCallback: (() => void) | undefined
  return {
    roles: { 'mock-address-123': { role: 'moderator' as const } },
    posts: {
      pageCids: postsConfig.pageCids ?? {},
      pages: postsConfig.pages ?? {},
      getPage: postsConfig.getPage ?? vi.fn(),
    },
    on: vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === 'update') updateCallback = cb
    }),
    update: vi.fn().mockImplementation(async () => {
      updateCallback?.()
    }),
    edit: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    removeListener: vi.fn(),
    // expose for tests to trigger update events manually
    _triggerUpdate: () => updateCallback?.(),
  }
}

describe('archiver logic', () => {
  let dir: string
  let stateDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archiver-test-'))
    stateDir = join(dir, 'states')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('state-based thread tracking', () => {
    it('records lockTimestamp when adding a locked thread', () => {
      const filePath = join(stateDir, 'test.json')
      const state: ArchiverState = { signers: {}, lockedThreads: {} }
      const now = Math.floor(Date.now() / 1000)
      state.lockedThreads['QmTest'] = { lockTimestamp: now }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.lockedThreads['QmTest'].lockTimestamp).toBe(now)
    })

    it('removes thread from state on purge', () => {
      const filePath = join(stateDir, 'test.json')
      const state: ArchiverState = {
        signers: {},
        lockedThreads: {
          'QmKeep': { lockTimestamp: 1000 },
          'QmPurge': { lockTimestamp: 500 },
        },
      }
      delete state.lockedThreads['QmPurge']
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.lockedThreads['QmKeep']).toBeDefined()
      expect(loaded.lockedThreads['QmPurge']).toBeUndefined()
    })
  })

  describe('thread filtering', () => {
    it('filters out pinned threads', () => {
      const threads = [
        mockThread('Qm1', { pinned: true }),
        mockThread('Qm2'),
        mockThread('Qm3'),
        mockThread('Qm4', { pinned: true }),
      ]
      const nonPinned = threads.filter((t) => !t.pinned)
      expect(nonPinned).toHaveLength(2)
      expect(nonPinned.map((t) => t.cid)).toEqual(['Qm2', 'Qm3'])
    })

    it('identifies threads beyond capacity', () => {
      const perPage = 2
      const pages = 2
      const maxThreads = perPage * pages // 4

      const threads = Array.from({ length: 6 }, (_, i) => mockThread(`Qm${i}`))
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)

      expect(beyondCapacity).toHaveLength(2)
      expect(beyondCapacity.map((t) => t.cid)).toEqual(['Qm4', 'Qm5'])
    })

    it('skips already locked threads', () => {
      const threads = [
        mockThread('Qm1'),
        mockThread('Qm2'),
        mockThread('Qm3', { locked: true }),
        mockThread('Qm4'),
        mockThread('Qm5'),
      ]
      const maxThreads = 2
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toLock = beyondCapacity.filter((t) => !t.locked)

      expect(toLock).toHaveLength(2)
      expect(toLock.map((t) => t.cid)).toEqual(['Qm4', 'Qm5'])
    })
  })

  describe('active sort from hot pages', () => {
    it('sorts threads by lastReplyTimestamp descending', () => {
      const threads = [
        mockThread('QmA', { lastReplyTimestamp: 100 }),
        mockThread('QmB', { lastReplyTimestamp: 300 }),
        mockThread('QmC', { lastReplyTimestamp: 200 }),
      ]
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
      expect(threads.map((t) => t.cid)).toEqual(['QmB', 'QmC', 'QmA'])
    })

    it('breaks ties by postNumber descending', () => {
      const threads = [
        mockThread('QmX', { lastReplyTimestamp: 500, postNumber: 10 }),
        mockThread('QmY', { lastReplyTimestamp: 500, postNumber: 30 }),
        mockThread('QmZ', { lastReplyTimestamp: 500, postNumber: 20 }),
      ]
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
      // Same timestamp → sorted by postNumber desc: 30, 20, 10
      expect(threads.map((t) => t.cid)).toEqual(['QmY', 'QmZ', 'QmX'])
    })
  })

  describe('bump limit detection', () => {
    it('identifies threads at or above bump limit', () => {
      const bumpLimit = 300
      const threads = [
        mockThread('Qm1', { replyCount: 100 }),
        mockThread('Qm2', { replyCount: 300 }),
        mockThread('Qm3', { replyCount: 500 }),
        mockThread('Qm4', { replyCount: 299 }),
      ]
      const atBumpLimit = threads.filter((t) => t.replyCount >= bumpLimit)
      expect(atBumpLimit.map((t) => t.cid)).toEqual(['Qm2', 'Qm3'])
    })

    it('skips locked threads when checking bump limit', () => {
      const bumpLimit = 300
      const threads = [
        mockThread('Qm1', { replyCount: 300, locked: true }),
        mockThread('Qm2', { replyCount: 400 }),
      ]
      const toLock = threads.filter((t) => t.replyCount >= bumpLimit && !t.locked)
      expect(toLock).toHaveLength(1)
      expect(toLock[0].cid).toBe('Qm2')
    })
  })

  describe('purge timing', () => {
    it('identifies threads past archive_purge_seconds', () => {
      const archivePurgeSeconds = 172800 // 48h
      const now = Math.floor(Date.now() / 1000)
      const state: ArchiverState = {
        signers: {},
        lockedThreads: {
          'QmOld': { lockTimestamp: now - 200000 }, // > 48h ago
          'QmRecent': { lockTimestamp: now - 1000 }, // < 48h ago
          'QmExact': { lockTimestamp: now - 172800 }, // exactly 48h ago
        },
      }

      const toPurge = Object.entries(state.lockedThreads)
        .filter(([_, info]) => now - info.lockTimestamp > archivePurgeSeconds)
      // "QmExact" is exactly at the boundary (not >), so only QmOld
      expect(toPurge.map(([cid]) => cid)).toEqual(['QmOld'])
    })

    it('does not purge threads locked less than archive_purge_seconds ago', () => {
      const archivePurgeSeconds = 172800
      const now = Math.floor(Date.now() / 1000)
      const state: ArchiverState = {
        signers: {},
        lockedThreads: {
          'Qm1': { lockTimestamp: now - 100 },
          'Qm2': { lockTimestamp: now },
        },
      }

      const toPurge = Object.entries(state.lockedThreads)
        .filter(([_, info]) => now - info.lockTimestamp > archivePurgeSeconds)
      expect(toPurge).toHaveLength(0)
    })
  })

  describe('signer management', () => {
    it('persists signer to state file', () => {
      const filePath = join(stateDir, 'test.json')
      const state: ArchiverState = { signers: {}, lockedThreads: {} }
      state.signers['my-board.eth'] = { privateKey: 'test-private-key' }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.signers['my-board.eth'].privateKey).toBe('test-private-key')
    })

    it('retrieves existing signer from state', () => {
      const filePath = join(stateDir, 'test.json')
      const state: ArchiverState = {
        signers: { 'board.eth': { privateKey: 'existing-key' } },
        lockedThreads: {},
      }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.signers['board.eth']).toBeDefined()
      expect(loaded.signers['board.eth'].privateKey).toBe('existing-key')
    })

    it('handles multiple signers for different subplebbits', () => {
      const filePath = join(stateDir, 'test.json')
      const state: ArchiverState = {
        signers: {
          'board1.eth': { privateKey: 'key1' },
          'board2.eth': { privateKey: 'key2' },
        },
        lockedThreads: {},
      }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(Object.keys(loaded.signers)).toHaveLength(2)
      expect(loaded.signers['board1.eth'].privateKey).toBe('key1')
      expect(loaded.signers['board2.eth'].privateKey).toBe('key2')
    })
  })

  describe('idempotency', () => {
    it('skips threads already tracked in lockedThreads state', () => {
      const state: ArchiverState = {
        signers: {},
        lockedThreads: { 'QmAlready': { lockTimestamp: 1000 } },
      }
      const threads = [mockThread('QmAlready'), mockThread('QmNew')]
      const maxThreads = 0 // all beyond capacity

      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toLock = beyondCapacity.filter((t) => !t.locked && !state.lockedThreads[t.cid])

      expect(toLock).toHaveLength(1)
      expect(toLock[0].cid).toBe('QmNew')
    })
  })

  describe('cold start', () => {
    it('handles many threads needing lock at once', () => {
      const perPage = 2
      const pages = 1
      const maxThreads = perPage * pages // 2

      // Simulate 50 threads on a board that's been running without archiver
      const threads = Array.from({ length: 50 }, (_, i) => mockThread(`Qm${i}`))
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toLock = beyondCapacity.filter((t) => !t.locked)

      expect(toLock).toHaveLength(48)
    })
  })

  describe('createCommentModeration mock', () => {
    it('creates lock moderation with correct shape', async () => {
      const { instance } = createMockPlebbit()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { locked: true },
        subplebbitAddress: 'board.eth',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(instance.createCommentModeration).toHaveBeenCalledWith({
        commentCid: 'QmTest',
        commentModeration: { locked: true },
        subplebbitAddress: 'board.eth',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(mod.publish).toBeDefined()
    })

    it('creates purge moderation with correct shape', async () => {
      const { instance } = createMockPlebbit()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { purged: true },
        subplebbitAddress: 'board.eth',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(mod.commentModeration.purged).toBe(true)
    })

    it('tracks published moderations', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { locked: true },
        subplebbitAddress: 'board.eth',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      await mod.publish()
      expect(publishedModerations).toHaveLength(1)
      expect(publishedModerations[0].commentCid).toBe('QmTest')
    })
  })

  describe('thread fetching scenarios', () => {
    it('returns early when subplebbit has no posts', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      const mockSub = createMockSubplebbit({
        pageCids: {},
        pages: {},
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 15,
        pages: 10,
      })

      // No moderations should have been published
      expect(publishedModerations).toHaveLength(0)
      await archiver.stop()
    })

    it('fetches all threads via pageCids.active with single page', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      const threadsOnPage = Array.from({ length: 5 }, (_, i) => mockThread(`QmActive${i}`))
      const getPage = vi.fn().mockResolvedValue({
        comments: threadsOnPage,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockSubplebbit({
        pageCids: { active: 'QmActivePage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 2,
        pages: 1, // capacity = 2, so 3 threads should get locked
      })

      // Wait for moderations to be published (3 threads beyond capacity of 2)
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      expect(getPage).toHaveBeenCalledWith({ cid: 'QmActivePage1' })

      const lockedCids = publishedModerations.map((m) => m.commentCid)
      expect(lockedCids).toEqual(['QmActive2', 'QmActive3', 'QmActive4'])
      await archiver.stop()
    })

    it('paginates via nextCid when multiple pages exist', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      const page1Threads = [mockThread('QmP1a'), mockThread('QmP1b')]
      const page2Threads = [mockThread('QmP2a'), mockThread('QmP2b')]

      const getPage = vi.fn()
        .mockResolvedValueOnce({ comments: page1Threads, nextCid: 'QmPage2Cid' } as Page)
        .mockResolvedValueOnce({ comments: page2Threads, nextCid: undefined } as Page)

      const mockSub = createMockSubplebbit({
        pageCids: { active: 'QmPage1Cid' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 1,
        pages: 1, // capacity = 1, so 3 threads should get locked
      })

      // 4 total threads, capacity 1 → 3 locked
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      // Verify both pages were fetched with correct CIDs
      expect(getPage).toHaveBeenCalledTimes(2)
      expect(getPage).toHaveBeenCalledWith({ cid: 'QmPage1Cid' })
      expect(getPage).toHaveBeenCalledWith({ cid: 'QmPage2Cid' })

      const lockedCids = publishedModerations.map((m) => m.commentCid)
      expect(lockedCids).toEqual(['QmP1b', 'QmP2a', 'QmP2b'])
      await archiver.stop()
    })

    it('falls back to preloaded hot page when pageCids.active is absent', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      // Threads with lastReplyTimestamp so active sort is deterministic
      const hotThreads = [
        mockThread('QmHot0', { lastReplyTimestamp: 400, postNumber: 1 }),
        mockThread('QmHot1', { lastReplyTimestamp: 300, postNumber: 2 }),
        mockThread('QmHot2', { lastReplyTimestamp: 200, postNumber: 3 }),
        mockThread('QmHot3', { lastReplyTimestamp: 100, postNumber: 4 }),
      ]

      const mockSub = createMockSubplebbit({
        pageCids: {}, // no active pageCid
        pages: {
          hot: { comments: hotThreads, nextCid: undefined } as Page,
        },
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 1,
        pages: 2, // capacity = 2, so 2 threads should get locked
      })

      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(2)
      })

      // After sort by lastReplyTimestamp desc: QmHot0(400), QmHot1(300), QmHot2(200), QmHot3(100)
      // Capacity 2 → QmHot2 and QmHot3 get locked
      const lockedCids = publishedModerations.map((m) => m.commentCid)
      expect(lockedCids).toEqual(['QmHot2', 'QmHot3'])
      await archiver.stop()
    })

    it('paginates hot pages via nextCid when pageCids.active is absent', async () => {
      const { instance, publishedModerations } = createMockPlebbit()
      // Page 1 (preloaded): newer threads
      const page1Threads = [
        mockThread('QmH1', { lastReplyTimestamp: 500, postNumber: 10 }),
        mockThread('QmH2', { lastReplyTimestamp: 400, postNumber: 9 }),
      ]
      // Page 2 (fetched via nextCid): older threads
      const page2Threads = [
        mockThread('QmH3', { lastReplyTimestamp: 300, postNumber: 8 }),
        mockThread('QmH4', { lastReplyTimestamp: 200, postNumber: 7 }),
      ]

      const getPage = vi.fn().mockResolvedValue({
        comments: page2Threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockSubplebbit({
        pageCids: {}, // no active pageCid
        pages: {
          hot: { comments: page1Threads, nextCid: 'QmHotPage2' } as Page,
        },
        getPage,
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 1,
        pages: 1, // capacity = 1, so 3 threads locked
      })

      // All 4 threads collected, sorted by lastReplyTimestamp desc: QmH1(500), QmH2(400), QmH3(300), QmH4(200)
      // Capacity 1 → 3 locked
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      expect(getPage).toHaveBeenCalledWith({ cid: 'QmHotPage2' })

      const lockedCids = publishedModerations.map((m) => m.commentCid)
      expect(lockedCids).toEqual(['QmH2', 'QmH3', 'QmH4'])
      await archiver.stop()
    })

    it('throws for remote subplebbit when signer has no mod role', async () => {
      const { instance } = createMockPlebbit()
      // subplebbits is empty → board.eth is remote
      ;(instance as unknown as { subplebbits: string[] }).subplebbits = []

      const mockSub = createMockSubplebbit({
        pageCids: {},
        pages: {},
      })
      // Signer has no role
      ;(mockSub as unknown as { roles: Record<string, unknown> }).roles = {}
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      await expect(startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })).rejects.toThrow(
        'Signer mock-address-123 does not have a moderator role on remote subplebbit board.eth. Ask the subplebbit owner to add this address as a moderator.'
      )
    })

    it('starts successfully for remote subplebbit when signer has mod role', async () => {
      const { instance } = createMockPlebbit()
      // subplebbits is empty → board.eth is remote
      ;(instance as unknown as { subplebbits: string[] }).subplebbits = []

      const mockSub = createMockSubplebbit({
        pageCids: {},
        pages: {},
      })
      // Signer already has moderator role
      mockSub.roles = { 'mock-address-123': { role: 'moderator' as const } }
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })

      // Should not have called edit (role already exists)
      expect(mockSub.edit).not.toHaveBeenCalled()
      await archiver.stop()
    })

    it('auto-grants mod role for local subplebbit without mod role', async () => {
      const { instance } = createMockPlebbit()
      // subplebbits includes board.eth → it's local
      ;(instance as unknown as { subplebbits: string[] }).subplebbits = ['board.eth']

      const mockSub = createMockSubplebbit({
        pageCids: {},
        pages: {},
      })
      // Signer has no role
      ;(mockSub as unknown as { roles: Record<string, unknown> }).roles = {}
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })

      // Should have called edit to auto-grant moderator role
      expect(mockSub.edit).toHaveBeenCalledWith({
        roles: { 'mock-address-123': { role: 'moderator' } },
      })
      await archiver.stop()
    })

    it('uses defaultStateDir when stateDir is not provided', async () => {
      const { instance } = createMockPlebbit()
      const mockSub = createMockSubplebbit({
        pageCids: {},
        pages: {},
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      // No stateDir passed — should use defaultStateDir() without error
      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        perPage: 15,
        pages: 10,
      })

      expect(mockSub.update).toHaveBeenCalled()

      await archiver.stop()
    })
  })

  describe('update serialization', () => {
    it('serializes concurrent update events', async () => {
      const { instance } = createMockPlebbit()

      // Use a deferred promise to block getPage so we can control timing
      let resolveGetPage: ((value: Page) => void) | undefined
      const getPageCalls: string[] = []
      const getPage = vi.fn().mockImplementation(({ cid }: { cid: string }) => {
        getPageCalls.push(cid)
        return new Promise<Page>((resolve) => {
          resolveGetPage = resolve
        })
      })

      const threads = [mockThread('Qm1'), mockThread('Qm2'), mockThread('Qm3')]

      const mockSub = createMockSubplebbit({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 15,
        pages: 10,
      })

      // First update is now in progress (blocked on getPage).
      // Wait for the first getPage call to be made.
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(1)
      })

      // Fire two more updates while the first is blocked.
      // Due to serialization, these should coalesce into a single re-run.
      mockSub._triggerUpdate()
      mockSub._triggerUpdate()

      // Resolve the first getPage — first handleUpdate completes
      resolveGetPage!({ comments: threads, nextCid: undefined } as Page)

      // Wait for the coalesced re-run's getPage call
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(2)
      })

      // Resolve the second getPage
      resolveGetPage!({ comments: threads, nextCid: undefined } as Page)

      // Wait for the second run to complete
      await new Promise((r) => setTimeout(r, 50))

      // getPage should have been called exactly 2 times (initial + one coalesced re-run),
      // NOT 3 times (which would indicate no coalescing)
      expect(getPageCalls).toHaveLength(2)

      await archiver.stop()
    })

    it('does not re-run when no update arrives during handleUpdate', async () => {
      const { instance } = createMockPlebbit()
      const getPageCalls: string[] = []
      const getPage = vi.fn().mockImplementation(({ cid }: { cid: string }) => {
        getPageCalls.push(cid)
        return Promise.resolve({ comments: [mockThread('Qm1')], nextCid: undefined } as Page)
      })

      const mockSub = createMockSubplebbit({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 15,
        pages: 10,
      })

      // The initial update from subplebbit.update() triggers one handleUpdate
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(1)
      })

      // Wait a bit to confirm no additional runs happen
      await new Promise((r) => setTimeout(r, 50))
      expect(getPageCalls).toHaveLength(1)

      await archiver.stop()
    })
  })

  describe('process lock', () => {
    it('throws when lock is held by a live PID', async () => {
      const statePath = join(stateDir, 'board.eth.json')
      const state: ArchiverState = {
        signers: {},
        lockedThreads: {},
        lock: { pid: process.pid },
      }
      saveState(statePath, state)

      const { instance } = createMockPlebbit()
      const mockSub = createMockSubplebbit({ pageCids: {}, pages: {} })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      await expect(startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })).rejects.toThrow(`Another archiver (PID ${process.pid}) is already running for board.eth`)
    })

    it('succeeds when lock has stale PID', async () => {
      const statePath = join(stateDir, 'board.eth.json')
      const state: ArchiverState = {
        signers: {},
        lockedThreads: {},
        lock: { pid: 999999 },
      }
      saveState(statePath, state)

      const { instance } = createMockPlebbit()
      const mockSub = createMockSubplebbit({ pageCids: {}, pages: {} })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })

      const loaded = loadState(statePath)
      expect(loaded.lock).toEqual({ pid: process.pid })
      await archiver.stop()
    })

    it('releases lock on stop()', async () => {
      const { instance } = createMockPlebbit()
      const mockSub = createMockSubplebbit({ pageCids: {}, pages: {} })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })

      const statePath = join(stateDir, 'board.eth.json')
      const beforeStop = loadState(statePath)
      expect(beforeStop.lock).toEqual({ pid: process.pid })

      await archiver.stop()

      const afterStop = loadState(statePath)
      expect(afterStop.lock).toBeUndefined()
    })

    it('can start again after stop()', async () => {
      const { instance } = createMockPlebbit()
      const mockSub = createMockSubplebbit({ pageCids: {}, pages: {} })
      vi.mocked(instance.getSubplebbit).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver1 = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })
      await archiver1.stop()

      // Re-mock Plebbit for second call since mock is consumed
      const { instance: instance2 } = createMockPlebbit()
      const mockSub2 = createMockSubplebbit({ pageCids: {}, pages: {} })
      vi.mocked(instance2.getSubplebbit).mockResolvedValue(mockSub2 as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver2 = await startArchiver({
        subplebbitAddress: 'board.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
      })

      const statePath = join(stateDir, 'board.eth.json')
      const loaded = loadState(statePath)
      expect(loaded.lock).toEqual({ pid: process.pid })
      await archiver2.stop()
    })

    it('isPidAlive returns true for current process', () => {
      expect(isPidAlive(process.pid)).toBe(true)
    })

    it('isPidAlive returns false for dead PID', () => {
      expect(isPidAlive(999999)).toBe(false)
    })
  })

  describe('per-subplebbit state isolation', () => {
    it('two archivers for different subplebbits use separate state files', async () => {
      // First archiver for board1.eth
      const { instance: instance1 } = createMockPlebbit()
      const mockSub1 = createMockSubplebbit({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage: vi.fn().mockResolvedValue({
          comments: [mockThread('QmBoard1Thread')],
          nextCid: undefined,
        } as Page),
      })
      vi.mocked(instance1.getSubplebbit).mockResolvedValue(mockSub1 as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver1 = await startArchiver({
        subplebbitAddress: 'board1.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 15,
        pages: 10,
      })

      // Second archiver for board2.eth
      const { instance: instance2 } = createMockPlebbit()
      const mockSub2 = createMockSubplebbit({
        pageCids: { active: 'QmPage2' },
        pages: {},
        getPage: vi.fn().mockResolvedValue({
          comments: [mockThread('QmBoard2Thread')],
          nextCid: undefined,
        } as Page),
      })
      vi.mocked(instance2.getSubplebbit).mockResolvedValue(mockSub2 as unknown as Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>)

      const archiver2 = await startArchiver({
        subplebbitAddress: 'board2.eth',
        plebbitRpcUrl: 'ws://localhost:9138',
        stateDir,
        perPage: 15,
        pages: 10,
      })

      // Wait for both archivers to process
      await vi.waitFor(() => {
        expect(existsSync(join(stateDir, 'board1.eth.json'))).toBe(true)
        expect(existsSync(join(stateDir, 'board2.eth.json'))).toBe(true)
      })

      // Verify each state file has its own signer and they don't clobber each other
      const state1 = loadState(join(stateDir, 'board1.eth.json'))
      const state2 = loadState(join(stateDir, 'board2.eth.json'))

      expect(state1.signers['board1.eth']).toBeDefined()
      expect(state2.signers['board2.eth']).toBeDefined()

      // Each file only has its own subplebbit's signer
      expect(state1.signers['board2.eth']).toBeUndefined()
      expect(state2.signers['board1.eth']).toBeUndefined()

      await archiver1.stop()
      await archiver2.stop()
    })
  })
})
