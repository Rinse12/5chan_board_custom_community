# Plebbit Auto-Archiving Module

An external module for plebbit-js subplebbits that implements 4chan-style thread auto-archiving and purging. Uses plebbit-js's public API (`plebbit.createCommentModeration()`) — **no plebbit-js modifications required**.

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

### Sage

Posting with "sage" in the options field doesn't bump the thread and doesn't count toward the bump limit.

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

## Plebbit-js Implementation Plan

### Architecture

External module using plebbit-js's public API:

- No plebbit-js core modifications needed
- Uses `plebbit.createCommentModeration()` for both locking and purging
- Listens to subplebbit `update` events to detect new posts
- Gets thread positions from `subplebbit.posts.pageCids.active` or calculates active sort from preloaded pages at `subplebbit.posts.pages.hot` using plebbit-js's `activeScore` function

### Configurable settings

Uses 4chan field names for interoperability.

| Setting | Default | 4chan range | Description |
|---------|---------|-------------|-------------|
| `per_page` | 15 | 15–30 | Threads per index page |
| `pages` | 10 | 1–10 | Number of index pages |
| `bump_limit` | 300 | 300–500 | Max replies before thread is locked |
| `archive_purge_seconds` | 172800 (48h) | ~48h | Seconds before locked posts are purged (no 4chan equivalent, 4chan uses ~48h) |

**Max active threads** = `per_page × pages` (default: 150)

### API note

Cannot do `subplebbit.posts.getPage("active")`. Must either:

1. Use `subplebbit.posts.pageCids.active` to get the CID, then fetch that page
2. Or calculate active sorting from preloaded pages at `subplebbit.posts.pages.hot` using imported `activeScore` rank function from plebbit-js

### Feature 1: Thread limit / auto-archive

- After each subplebbit update, determine thread positions in active sort
- Filter out pinned threads (they're exempt)
- Count non-pinned threads; any beyond position `per_page × pages` → lock via `createCommentModeration({ commentModeration: { locked: true } })`
- Locked threads are read-only (plebbit-js already enforces this)

### Feature 2: Bump limit

- Track reply counts for active threads
- When a thread reaches `bump_limit` replies → lock it via `createCommentModeration({ commentModeration: { locked: true } })`

**Difference from 4chan behavior:** On 4chan, threads past bump limit still accept replies but just don't get bumped in sort order. True bump-limit-without-locking would require a plebbit-js change to the active sort CTE query (ignoring replies after the Nth for sort calculation). Locking is a simpler approximation.

### Feature 3: Delayed purge

- Track when threads were locked (archived)
- After `archive_purge_seconds` has elapsed since locking → purge via `createCommentModeration({ commentModeration: { purged: true } })`

### Module flow

```
1. Create plebbit instance with moderator signer
2. Get subplebbit and call subplebbit.update()
3. On each 'update' event:
   a. Get active sort from subplebbit.posts.pageCids.active
      or calculate from subplebbit.posts.pages.hot using activeScore
   b. Walk through pages to build full ordered list of threads
   c. Filter out pinned threads
   d. For each non-pinned thread beyond position (per_page * pages):
      - createCommentModeration({ locked: true }) and publish
   e. For each thread with replyCount >= bump_limit:
      - createCommentModeration({ locked: true }) and publish
   f. For each locked thread where (now - lockedAt) > archive_purge_seconds:
      - createCommentModeration({ purged: true }) and publish
```

### Key plebbit-js APIs used

| API | Purpose |
|-----|---------|
| `plebbit.createCommentModeration()` | Lock and purge threads |
| `commentModeration.publish()` | Publish the moderation action |
| `subplebbit.posts.pageCids.active` | Get active sort page CID |
| `subplebbit.posts.pages.hot` | Preloaded first page (for calculating active sort) |
| `subplebbit.on('update', ...)` | Listen for new posts/updates |
| `page.nextCid` | Paginate through multi-page feeds |

### Key plebbit-js source files (reference only, not modified)

| File | Relevant code |
|------|--------------|
| `src/plebbit/plebbit.ts:806` | `createCommentModeration()` definition |
| `src/publications/comment-moderation/schema.ts:24` | ModeratorOptionsSchema with `locked`, `purged` fields |
| `src/runtime/node/subplebbit/local-subplebbit.ts:1658` | Existing locked check that blocks replies |
| `src/runtime/node/subplebbit/db-handler.ts:2567` | `queryPostsWithActiveScore()` — active sort CTE |
| `src/pages/util.ts` | Sort type definitions and scoring functions |
