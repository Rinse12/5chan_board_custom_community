# Plebbit Auto-Archiving Module

An ESM TypeScript npm package that implements 4chan-style thread auto-archiving and purging for plebbit-js subplebbits. Uses plebbit-js's public API (`plebbit.createCommentModeration()`) — **no plebbit-js modifications required**.

> **Node.js only.** This is a Node.js-only ESM package — it requires a Plebbit RPC server connection and uses Node.js APIs (`fs`, `node:util`). Apps using it as a library (like 5chan) must run the archiver in a Node.js environment, not in the browser.

Works two ways:
1. **Library** — imported by 5chan (web UI) as a dependency
2. **CLI** — `node dist/cli.js <subplebbit-address> [--flags]`

## Library API

```ts
import { startArchiver } from '5chan-board-archiver'

const archiver = await startArchiver({
  subplebbitAddress: 'my-board.eth',
  plebbitRpcUrl: 'ws://localhost:9138', // Plebbit RPC WebSocket URL
  statePath: '/custom/path/state.json', // optional, defaults to OS data dir
  perPage: 15,    // optional, default 15
  pages: 10,      // optional, default 10
  bumpLimit: 300, // optional, default 300
  archivePurgeSeconds: 172800, // optional, default 172800 (48h)
})

// Later, to stop:
await archiver.stop()
```

- `plebbitRpcUrl` is the WebSocket URL of a running Plebbit RPC server (Plebbit instance is created and destroyed internally)
- Returns `{ stop(): Promise<void> }` — stops the archiver, cleans up event listeners, and destroys the Plebbit instance

## CLI Usage

```bash
node --env-file=.env dist/cli.js <subplebbit-address> [--rpc-url URL] [--per-page N] [--pages N] [--bump-limit N] [--archive-purge-seconds N] [--state-path PATH]
```

- Uses Node 22's built-in `--env-file` flag (no dotenv dependency)
- CLI flags override `.env` values
- `<subplebbit-address>` is a required positional argument

Or via npm script:

```bash
npm start -- <subplebbit-address> [--flags]
```

## .env Configuration

```env
PLEBBIT_RPC_WS_URL=ws://localhost:9138  # optional, defaults to ws://localhost:9138
ARCHIVER_STATE_PATH=                     # optional, defaults to OS data dir (~/.local/share/5chan-archiver/state.json)
PER_PAGE=15
PAGES=10
BUMP_LIMIT=300
ARCHIVE_PURGE_SECONDS=172800
```

No mod private key in `.env` — signers are auto-managed in the state JSON per subplebbit (see below).

## Auto Mod Signer Management

On startup for each subplebbit (using the internally-created Plebbit instance):

1. Check state JSON for a signer private key for this subplebbit address
2. If none exists, create one via `plebbit.createSigner()` and save to state JSON
3. Check `subplebbit.roles` for the signer's address
4. If not a mod, auto-add via `subplebbit.edit()` (works because we run on LocalSubplebbit or RpcLocalSubplebbit — we own the sub)

Logged via `plebbit-logger` when creating signer or adding mod role.

## State Persistence

`archivedAt` is not in plebbit-js's schema, so the script persists state to a JSON file in the OS data directory (via `env-paths`: `~/.local/share/5chan-archiver/state.json`) or a custom path via `--state-path` / `ARCHIVER_STATE_PATH`.

```json
{
  "signers": {
    "<subplebbitAddress>": { "privateKey": "..." }
  },
  "archivedThreads": {
    "<commentCid>": { "archivedTimestamp": 1234567890 }
  }
}
```

- **`signers`**: maps subplebbit address → mod signer private key (auto-created if missing)
- **`archivedThreads`**: maps comment CID → archive metadata
- Top-level object allows adding future state categories
- Per-entry objects allow adding future metadata
- Loaded on startup, written on archive, entries removed on purge

## Cold Start

The script may start long after the board has been running. On first run, many threads may need locking/purging at once. No rate limiting is needed — same-node publishing has no pubsub overhead. The first cycle may be heavier; steady-state handles a few threads per update.

## Idempotency

Before archiving, checks the thread's `archived` property. Skips if already archived (plebbit-js throws on duplicate moderation actions).

## Logging

Uses `plebbit-logger` (same logger as the plebbit-js ecosystem). Key events logged:

- Archiver start/stop
- Threads archived (with CID and reason: capacity vs bump limit)
- Threads purged
- Mod role auto-added
- Errors

## 4chan Board Behavior Reference

### Board capacity

Total thread capacity = `per_page × pages`. Both are **configurable per board**.

| Setting | Range | Description |
|---------|-------|-------------|
| `per_page` | 15–30 | Threads per index page (e.g., /b/ = 15, /v/ = 20, /f/ = 30) |
| `pages` | 1–10 | Number of index pages (e.g., /f/ = 1, most boards = 10) |

Capacity examples: /b/ = 150, /v/ = 200, /f/ = 30.

### Thread lifecycle

1. **New thread created** → sits at top of page 1
2. **Bumped by replies** → moves back to top of page 1
3. **Sinks gradually** as newer threads get replies
4. **Falls off last page** → archived (read-only, ~48h)
5. **Purged** → permanently deleted from 4chan's servers

### Bumping

A reply moves the thread to the top of page 1. This is equivalent to plebbit's **"active sort"**, which orders threads by `lastReplyTimestamp`.

### Bump limit

Configurable per board (300–500+). After N replies, new replies no longer bump the thread, but it still accepts replies until it falls off the last page.

Examples: /b/ = 300, /3/ = 310, /v/ = 500.

### Pinned (sticky) threads

Sit at top of page 1, exempt from thread limit and archiving. "Pinned" and "sticky" are the same thing.

### Archive vs purge

- **Archived** = locked/read-only, still visible for ~48 hours
- **Purged** = permanently deleted from 4chan's servers
- Not all boards have archives (`is_archived` flag in API)

### Third-party archives

External services (archive.4plebs.org, desuarchive.org) independently scrape and preserve threads before purge.

### Other per-board settings from 4chan API

`image_limit`, `max_filesize`, `max_comment_chars`, `cooldowns`, `spoilers`, `country_flags`, `user_ids`, `forced_anon`, etc.

## Differences from 4chan

| Behavior | 4chan | This module |
|----------|------|-------------|
| **Bump limit** | Threads past bump limit still accept replies — they just stop rising in the catalog | Threads are **archived** (no more replies) because plebbit-js has no "stop bumping without archiving" mechanism |
| **Sage** | Replying with `sage` in the email field prevents the thread from being bumped | Not supported — plebbit has no equivalent mechanism, so all replies bump the thread |
| **Image limit** | Per-thread image limit (e.g., 150 images on /b/) after which no more images can be posted | Not implemented — plebbit-js has its own file-size constraints but no per-thread image count limit |

## Plebbit-js Implementation

### Architecture

External module using plebbit-js's public API:

- No plebbit-js core modifications needed
- Uses `plebbit.createCommentModeration()` for both archiving and purging
- Listens to subplebbit `update` events to detect new posts
- Gets thread positions from `subplebbit.posts.pageCids.active`, or falls back to sorting preloaded pages by `lastReplyTimestamp` descending (then `postNumber`)

### Configurable settings

Uses 4chan field names for interoperability.

| Setting | Default | 4chan range | Description |
|---------|---------|-------------|-------------|
| `per_page` | 15 | 15–30 | Threads per index page |
| `pages` | 10 | 1–10 | Number of index pages |
| `bump_limit` | 300 | 300–500 | Max replies before thread is archived |
| `archive_purge_seconds` | 172800 (48h) | ~48h | Seconds before archived posts are purged (no 4chan equivalent, 4chan uses ~48h) |

**Max active threads** = `per_page × pages` (default: 150)

### API note

Cannot do `subplebbit.posts.getPage("active")`. Must either:

1. Use `subplebbit.posts.pageCids.active` to get the CID, then fetch that page
2. Or fall back to sorting preloaded pages by `lastReplyTimestamp` descending, then `postNumber` (approximates active sort without needing `pageCids.active`)

### Subplebbit record size constraint

The entire subplebbit IPFS record is capped at 1MB (`MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS`). `subplebbit.posts.pages.hot` is preloaded into the record with whatever space remains after the rest of the record (title, description, roles, challenges, etc.).

- If the preloaded page has **no `nextCid`**, it contains all posts — no pagination needed
- If `nextCid` **is present**, additional pages must be fetched via `subplebbit.posts.getPage({ cid: nextCid })`
- `subplebbit.posts.pageCids.active` provides the CID of the first active-sorted page, which is the sort order the archiver needs

Reference: `plebbit-js/src/subplebbit/subplebbit-client-manager.ts:38`, `plebbit-js/src/runtime/node/subplebbit/local-subplebbit.ts:714`

### Feature 1: Thread limit / auto-archive

- After each subplebbit update, determine thread positions in active sort
- Filter out pinned threads (they're exempt)
- Count non-pinned threads; any beyond position `per_page × pages` → archive via `createCommentModeration({ commentModeration: { archived: true } })`
- Archived threads are read-only (plebbit-js already enforces this)

### Feature 2: Bump limit

- Track reply counts for active threads
- When a thread reaches `bump_limit` replies → archive it via `createCommentModeration({ commentModeration: { archived: true } })`

### Feature 3: Delayed purge

- Track when threads were archived
- After `archive_purge_seconds` has elapsed since archiving → purge via `createCommentModeration({ commentModeration: { purged: true } })`

### Module flow

```
1. Create Plebbit instance internally from the provided plebbitRpcUrl
2. Load state JSON; get or create signer for this subplebbit via plebbit.createSigner()
3. Get subplebbit (LocalSubplebbit or RpcLocalSubplebbit)
4. Check subplebbit.roles for signer address; if missing, subplebbit.edit() to add as mod
5. Call subplebbit.update()
6. On each 'update' event:
   a. Determine thread source (three scenarios):
      1. pageCids.active exists → fetch via getPage(), paginate via nextCid
      2. Only pages.hot exists → use preloaded page, sort by lastReplyTimestamp desc then postNumber
      3. Neither exists → no posts, return early
   b. Walk through pages to build full ordered list of threads
   c. Filter out pinned threads
   d. For each non-pinned thread beyond position (per_page * pages):
      - Skip if already archived
      - createCommentModeration({ archived: true }) and publish
      - Record archivedTimestamp in state file
   e. For each thread with replyCount >= bump_limit:
      - Skip if already archived
      - createCommentModeration({ archived: true }) and publish
      - Record archivedTimestamp in state file
   f. For each archived thread where (now - archivedAt) > archive_purge_seconds:
      - createCommentModeration({ purged: true }) and publish
      - Remove from state file
```

### Key plebbit-js APIs used

| API | Purpose |
|-----|---------|
| `plebbit.createCommentModeration()` | Archive and purge threads |
| `commentModeration.publish()` | Publish the moderation action |
| `subplebbit.posts.pageCids.active` | Get active sort page CID |
| `subplebbit.posts.pages.hot` | Preloaded first page (for calculating active sort) |
| `subplebbit.on('update', ...)` | Listen for new posts/updates |
| `page.nextCid` | Paginate through multi-page feeds |

### Key plebbit-js source files (reference only, not modified)

| File | Relevant code |
|------|--------------|
| `src/plebbit/plebbit.ts:806` | `createCommentModeration()` definition |
| `src/publications/comment-moderation/schema.ts:24` | ModeratorOptionsSchema with `archived`, `purged` fields |
| `src/runtime/node/subplebbit/local-subplebbit.ts:1658` | Existing archived check that blocks replies |
| `src/runtime/node/subplebbit/db-handler.ts:2567` | `queryPostsWithActiveScore()` — active sort CTE |
| `src/pages/util.ts` | Sort type definitions and scoring functions |
