import Plebbit from '@plebbit/plebbit-js'
import Logger from '@plebbit/plebbit-logger'
import { join } from 'node:path'
import { loadState, saveState, defaultStateDir, isPidAlive } from './state.js'
import type { ArchiverOptions, ArchiverResult, ArchiverState, Subplebbit, Signer, ThreadComment, Page } from './types.js'

const log = Logger('5chan-archiver')

const DEFAULTS = {
  perPage: 15,
  pages: 10,
  bumpLimit: 300,
  archivePurgeSeconds: 172800,
} as const

export async function startArchiver(options: ArchiverOptions): Promise<ArchiverResult> {
  const {
    subplebbitAddress,
    plebbitRpcUrl,
    perPage = DEFAULTS.perPage,
    pages = DEFAULTS.pages,
    bumpLimit = DEFAULTS.bumpLimit,
    archivePurgeSeconds = DEFAULTS.archivePurgeSeconds,
  } = options

  const maxThreads = perPage * pages
  const stateDir = options.stateDir ?? defaultStateDir()
  const statePath = join(stateDir, `${subplebbitAddress}.json`)
  let state: ArchiverState = loadState(statePath)

  if (state.lock && isPidAlive(state.lock.pid)) {
    throw new Error(`Another archiver (PID ${state.lock.pid}) is already running for ${subplebbitAddress}`)
  }
  state.lock = { pid: process.pid }
  saveState(statePath, state)

  let stopped = false

  log(`starting archiver for ${subplebbitAddress} (capacity=${maxThreads}, bumpLimit=${bumpLimit}, purgeAfter=${archivePurgeSeconds}s)`)

  const plebbit = await Plebbit({ plebbitRpcClientsOptions: [plebbitRpcUrl] })

  async function ensureModRole(subplebbit: Subplebbit, signerAddress: string): Promise<void> {
    const roles = subplebbit.roles ?? {}
    if (roles[signerAddress]?.role === 'moderator' || roles[signerAddress]?.role === 'admin' || roles[signerAddress]?.role === 'owner') {
      return
    }
    if (!plebbit.subplebbits.includes(subplebbitAddress)) {
      throw new Error(
        `Signer ${signerAddress} does not have a moderator role on remote subplebbit ${subplebbitAddress}. Ask the subplebbit owner to add this address as a moderator.`
      )
    }
    log(`adding moderator role for ${signerAddress} on ${subplebbitAddress}`)
    await subplebbit.edit({
      roles: {
        ...roles,
        [signerAddress]: { role: 'moderator' },
      },
    })
  }

  async function getOrCreateSigner(): Promise<Signer> {
    if (state.signers[subplebbitAddress]) {
      return plebbit.createSigner({ privateKey: state.signers[subplebbitAddress].privateKey, type: 'ed25519' })
    }
    log(`creating new signer for ${subplebbitAddress}`)
    const signer = await plebbit.createSigner()
    state.signers[subplebbitAddress] = { privateKey: signer.privateKey }
    saveState(statePath, state)
    return signer
  }

  async function archiveThread(commentCid: string, signer: Signer, reason: string): Promise<void> {
    log(`archiving thread ${commentCid} (${reason})`)
    const mod = await plebbit.createCommentModeration({
      commentCid,
      commentModeration: { archived: true },
      subplebbitAddress,
      signer,
    })
    await mod.publish()
    state.archivedThreads[commentCid] = { archivedTimestamp: Math.floor(Date.now() / 1000) }
    saveState(statePath, state)
  }

  async function purgeThread(commentCid: string, signer: Signer): Promise<void> {
    log(`purging thread ${commentCid}`)
    const mod = await plebbit.createCommentModeration({
      commentCid,
      commentModeration: { purged: true },
      subplebbitAddress,
      signer,
    })
    await mod.publish()
    delete state.archivedThreads[commentCid]
    saveState(statePath, state)
  }

  async function handleUpdate(subplebbit: Subplebbit, signer: Signer): Promise<void> {
    if (stopped) return

    // Scenario 3: no posts at all — nothing to archive.
    const preloadedPage = Object.values(subplebbit.posts.pages)[0]
    if (!subplebbit.posts.pageCids.active && !preloadedPage) {
      return
    }

    // Build full thread list from active sort pages.
    // The subplebbit IPFS record is capped at 1MB total. The first preloaded page
    // is loaded into whatever space remains. If all posts fit, there's no nextCid.
    // If they don't fit, nextCid points to additional pages to fetch.
    const threads: ThreadComment[] = []

    if (subplebbit.posts.pageCids.active) {
      // Scenario 1: pageCids.active exists — fetch active-sorted pages
      let page: Page = await subplebbit.posts.getPage({ cid: subplebbit.posts.pageCids.active })
      threads.push(...page.comments)
      while (page.nextCid) {
        page = await subplebbit.posts.getPage({ cid: page.nextCid })
        threads.push(...page.comments)
      }
    } else if (preloadedPage?.comments) {
      // Scenario 2: no pageCids.active — collect all preloaded pages, sort by active
      threads.push(...preloadedPage.comments)
      let nextCid = preloadedPage.nextCid
      while (nextCid) {
        const page: Page = await subplebbit.posts.getPage({ cid: nextCid })
        threads.push(...page.comments)
        nextCid = page.nextCid
      }
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
    }

    // Filter out pinned threads
    const nonPinned = threads.filter((t: ThreadComment) => !t.pinned)

    // Archive threads beyond capacity
    for (const thread of nonPinned.slice(maxThreads)) {
      if (thread.archived) continue
      if (state.archivedThreads[thread.cid]) continue
      try {
        await archiveThread(thread.cid, signer, 'capacity')
      } catch (err) {
        log.error(`failed to archive thread ${thread.cid}: ${err}`)
      }
    }

    // Archive threads past bump limit
    for (const thread of nonPinned) {
      if (thread.archived) continue
      if (state.archivedThreads[thread.cid]) continue
      if ((thread.replyCount ?? 0) >= bumpLimit) {
        try {
          await archiveThread(thread.cid, signer, 'bump-limit')
        } catch (err) {
          log.error(`failed to archive thread ${thread.cid}: ${err}`)
        }
      }
    }

    // Purge archived threads past archive_purge_seconds
    const now = Math.floor(Date.now() / 1000)
    for (const [cid, info] of Object.entries(state.archivedThreads)) {
      if (now - info.archivedTimestamp > archivePurgeSeconds) {
        try {
          await purgeThread(cid, signer)
        } catch (err) {
          log.error(`failed to purge thread ${cid}: ${err}`)
        }
      }
    }
  }

  // Startup: get signer, subplebbit, ensure mod role, subscribe to updates
  const signer = await getOrCreateSigner()
  const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress })
  await ensureModRole(subplebbit, signer.address)

  let updateRunning = false
  let updatePendingRerun = false

  const updateHandler = () => {
    if (updateRunning) {
      updatePendingRerun = true
      return
    }
    updateRunning = true

    const run = async (): Promise<void> => {
      try {
        const signer = await getOrCreateSigner()
        await handleUpdate(subplebbit, signer)
      } catch (err) {
        log.error(`update handler error: ${err}`)
      }
      if (updatePendingRerun && !stopped) {
        updatePendingRerun = false
        return run()
      }
      updateRunning = false
    }

    run()
  }

  subplebbit.on('update', updateHandler)
  await subplebbit.update()
  log(`archiver running for ${subplebbitAddress}`)

  return {
    async stop() {
      stopped = true
      subplebbit.removeListener('update', updateHandler)
      delete state.lock
      saveState(statePath, state)
      await subplebbit.stop?.()
      await plebbit.destroy()
      log(`archiver stopped for ${subplebbitAddress}`)
    },
  }
}
