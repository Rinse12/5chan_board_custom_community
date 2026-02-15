import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startArchiver } from '../src/archiver.js'
import type { PlebbitInstance, ArchiverResult } from '../src/types.js'
import {
  RPC_URL,
  createPlebbitRpc,
  createTestSubplebbit,
  publishThread,
  publishReply,
  waitForThreadInPages,
  waitForThreadArchived,
  waitForThreadPinned,
  waitForReplyCount,
  waitForArchivedInState,
  waitForPurgedFromState,
  waitForSignerInState,
  createTempStateDir,
  cleanupTempDir,
  readStateFile,
  getAllThreads,
} from './helpers.js'

describe('archiver E2E', () => {
  let plebbit: PlebbitInstance

  beforeAll(async () => {
    plebbit = await createPlebbitRpc()
  })

  afterAll(async () => {
    await plebbit.destroy()
  })

  describe('capacity archiving', () => {
    it('archives threads beyond capacity', async () => {
      const { sub, address } = await createTestSubplebbit(plebbit)
      const { dir, statePath } = createTempStateDir()
      let archiver: ArchiverResult | undefined

      try {
        // Publish 4 threads sequentially, waiting for each to appear in pages
        const t1 = await publishThread(plebbit, address, 'Thread 1')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(plebbit, address, 'Thread 2')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(plebbit, address, 'Thread 3')
        await waitForThreadInPages(sub, t3.cid)

        const t4 = await publishThread(plebbit, address, 'Thread 4')
        await waitForThreadInPages(sub, t4.cid)

        // capacity = perPage * pages = 1 * 2 = 2
        // Active sort: T4 (newest), T3, T2, T1 (oldest)
        // T1 and T2 are beyond capacity and should be archived
        archiver = await startArchiver({
          subplebbitAddress: address,
          plebbitRpcUrl: RPC_URL,
          statePath,
          perPage: 1,
          pages: 2,
        })

        // Wait for the oldest threads to be archived in state
        await waitForArchivedInState(statePath, t1.cid)
        await waitForArchivedInState(statePath, t2.cid)

        // Verify state file
        const state = readStateFile(statePath)
        expect(state.archivedThreads[t1.cid]).toBeDefined()
        expect(state.archivedThreads[t2.cid]).toBeDefined()
        expect(state.archivedThreads[t3.cid]).toBeUndefined()
        expect(state.archivedThreads[t4.cid]).toBeUndefined()
        expect(state.signers[address]).toBeDefined()

        // Verify threads are actually archived in subplebbit pages
        await waitForThreadArchived(sub, t1.cid)
        await waitForThreadArchived(sub, t2.cid)

        // Verify T3 and T4 are NOT archived in pages
        const threads = await getAllThreads(sub)
        const t3InPages = threads.find((t) => t.cid === t3.cid)
        const t4InPages = threads.find((t) => t.cid === t4.cid)
        expect(t3InPages?.archived).toBeUndefined()
        expect(t4InPages?.archived).toBeUndefined()
      } finally {
        if (archiver) await archiver.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })

    it('does not archive threads within capacity', async () => {
      const { sub, address } = await createTestSubplebbit(plebbit)
      const { dir, statePath } = createTempStateDir()
      let archiver: ArchiverResult | undefined

      try {
        // Publish 3 threads
        const t1 = await publishThread(plebbit, address, 'Thread A')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(plebbit, address, 'Thread B')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(plebbit, address, 'Thread C')
        await waitForThreadInPages(sub, t3.cid)

        // capacity = 5 * 1 = 5, we only have 3 threads — all within capacity
        archiver = await startArchiver({
          subplebbitAddress: address,
          plebbitRpcUrl: RPC_URL,
          statePath,
          perPage: 5,
          pages: 1,
        })

        // Wait for archiver to be ready (signer created in state)
        await waitForSignerInState(statePath, address)

        // Give a few update cycles
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        // Verify no threads were archived in state
        const state = readStateFile(statePath)
        expect(Object.keys(state.archivedThreads)).toHaveLength(0)

        // Verify no threads are archived in pages
        const threads = await getAllThreads(sub)
        for (const thread of threads) {
          expect(thread.archived).toBeUndefined()
        }
      } finally {
        if (archiver) await archiver.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('bump limit', () => {
    it('archives thread that reaches bump limit', async () => {
      const { sub, address } = await createTestSubplebbit(plebbit)
      const { dir, statePath } = createTempStateDir()
      let archiver: ArchiverResult | undefined

      try {
        // Publish 1 thread + 3 replies
        const thread = await publishThread(plebbit, address, 'Bump Limit Thread')
        await waitForThreadInPages(sub, thread.cid)

        await publishReply(plebbit, address, thread.cid)
        await publishReply(plebbit, address, thread.cid)
        await publishReply(plebbit, address, thread.cid)

        // Wait for replyCount to reach 3 in pages
        await waitForReplyCount(sub, thread.cid, 3)

        // bumpLimit=3, large capacity so only bump limit triggers
        archiver = await startArchiver({
          subplebbitAddress: address,
          plebbitRpcUrl: RPC_URL,
          statePath,
          bumpLimit: 3,
          perPage: 15,
          pages: 10,
        })

        // Wait for thread to be archived in state
        await waitForArchivedInState(statePath, thread.cid)

        // Verify state
        const state = readStateFile(statePath)
        expect(state.archivedThreads[thread.cid]).toBeDefined()

        // Verify thread is actually archived in subplebbit pages
        await waitForThreadArchived(sub, thread.cid)
      } finally {
        if (archiver) await archiver.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('purge', () => {
    it('purges archived thread after archivePurgeSeconds', async () => {
      const { sub, address } = await createTestSubplebbit(plebbit)
      const { dir, statePath } = createTempStateDir()
      let archiver: ArchiverResult | undefined

      try {
        // Publish 2 threads (T1 oldest, T2 newest)
        const t1 = await publishThread(plebbit, address, 'Old Thread')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(plebbit, address, 'New Thread')
        await waitForThreadInPages(sub, t2.cid)

        // capacity=1, purge after 5 seconds
        archiver = await startArchiver({
          subplebbitAddress: address,
          plebbitRpcUrl: RPC_URL,
          statePath,
          perPage: 1,
          pages: 1,
          archivePurgeSeconds: 5,
        })

        // T1 should get archived first (beyond capacity)
        await waitForArchivedInState(statePath, t1.cid)

        // Verify it's archived in state
        const stateBeforePurge = readStateFile(statePath)
        expect(stateBeforePurge.archivedThreads[t1.cid]).toBeDefined()

        // Wait for purge (5s purge + polling time)
        await waitForPurgedFromState(statePath, t1.cid, 60_000)

        // Verify T1 removed from state (purged)
        const stateAfterPurge = readStateFile(statePath)
        expect(stateAfterPurge.archivedThreads[t1.cid]).toBeUndefined()
      } finally {
        if (archiver) await archiver.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('pinned thread exemption', () => {
    it('does not archive pinned threads', async () => {
      const { sub, address } = await createTestSubplebbit(plebbit)
      const { dir, statePath } = createTempStateDir()
      let archiver: ArchiverResult | undefined

      try {
        // Publish 3 threads
        const t1 = await publishThread(plebbit, address, 'Thread X')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(plebbit, address, 'Thread Y')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(plebbit, address, 'Thread Z')
        await waitForThreadInPages(sub, t3.cid)

        // Pin T3 using a moderator signer
        const modSigner = await plebbit.createSigner()
        await sub.edit({
          roles: { ...sub.roles, [modSigner.address]: { role: 'moderator' } },
        })
        const pinMod = await plebbit.createCommentModeration({
          commentCid: t3.cid,
          commentModeration: { pinned: true },
          subplebbitAddress: address,
          signer: modSigner,
        })
        await pinMod.publish()

        // Wait for T3 to show as pinned in pages
        await waitForThreadPinned(sub, t3.cid)

        // capacity=1, so among non-pinned (T1, T2), only 1 fits
        // Active sort: T2 (newer), T1 (older) → T1 beyond capacity
        archiver = await startArchiver({
          subplebbitAddress: address,
          plebbitRpcUrl: RPC_URL,
          statePath,
          perPage: 1,
          pages: 1,
        })

        // Wait for T1 to be archived (oldest non-pinned beyond capacity)
        await waitForArchivedInState(statePath, t1.cid)

        // Verify state
        const state = readStateFile(statePath)
        expect(state.archivedThreads[t1.cid]).toBeDefined()
        expect(state.archivedThreads[t2.cid]).toBeUndefined()
        expect(state.archivedThreads[t3.cid]).toBeUndefined()

        // Verify T1 is actually archived in pages
        await waitForThreadArchived(sub, t1.cid)

        // Verify T3 is NOT archived in pages (pinned exempt)
        const threads = await getAllThreads(sub)
        const t3InPages = threads.find((t) => t.cid === t3.cid)
        expect(t3InPages?.archived).toBeUndefined()
        expect(t3InPages?.pinned).toBe(true)

        // Verify T2 is NOT archived in pages
        const t2InPages = threads.find((t) => t.cid === t2.cid)
        expect(t2InPages?.archived).toBeUndefined()
      } finally {
        if (archiver) await archiver.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })
})
