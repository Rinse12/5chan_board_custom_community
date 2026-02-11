import type PlebbitFn from '@plebbit/plebbit-js'

/** The Plebbit instance type returned by `await Plebbit()` */
export type PlebbitInstance = Awaited<ReturnType<typeof PlebbitFn>>

/** Subplebbit returned by `plebbit.getSubplebbit()` */
export type Subplebbit = Awaited<ReturnType<PlebbitInstance['getSubplebbit']>>

/** Signer returned by `plebbit.createSigner()` */
export type Signer = Awaited<ReturnType<PlebbitInstance['createSigner']>>

/** A single page returned by `subplebbit.posts.getPage()` */
export type Page = Awaited<ReturnType<Subplebbit['posts']['getPage']>>

/** A comment/thread within a page */
export type ThreadComment = Page['comments'][number]

export interface ArchiverOptions {
  subplebbitAddress: string
  plebbit: PlebbitInstance
  statePath?: string
  perPage?: number
  pages?: number
  bumpLimit?: number
  archivePurgeSeconds?: number
}

export interface ArchiverResult {
  stop: () => Promise<void>
}

export interface SignerState {
  privateKey: string
}

export interface LockedThread {
  lockTimestamp: number
}

export interface ArchiverState {
  signers: Record<string, SignerState>
  lockedThreads: Record<string, LockedThread>
}
