# git-fs-s3

[![npm version](https://img.shields.io/npm/v/@nandan-varma/git-fs-s3.svg)](https://www.npmjs.com/package/@nandan-varma/git-fs-s3)
[![CI](https://github.com/nandan-varma/git-fs-s3/actions/workflows/ci.yml/badge.svg)](https://github.com/nandan-varma/git-fs-s3/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@nandan-varma/git-fs-s3.svg)](LICENSE)

An [isomorphic-git](https://isomorphic-git.org) filesystem backend for S3-compatible object storage — AWS S3, Cloudflare R2, MinIO, Backblaze B2. Run git repositories on serverless platforms with **no disk, no git binary, and no state between invocations**.

```
isomorphic-git  ──fs──►  git-fs-s3  ──►  ObjectStore  ──►  S3 / R2 / MinIO / memory
```

Extracted from the git layer of a production git-hosting service, where it serves clones, pushes, and repo browsing directly against Cloudflare R2 from Vercel functions.

## Why

isomorphic-git removed the need for a native `git` binary, but it still expects a filesystem. On Lambda, Vercel, or Cloudflare Workers you don't have a durable one. This package maps the fs contract git actually uses onto object-storage keys, so a bare repository lives entirely in a bucket:

```
repos/alice/blog/HEAD
repos/alice/blog/refs/heads/main
repos/alice/blog/objects/e6/9de29bb2d1d6434b8b29ae775ad8c2e48c5391
```

Use it to build git-backed CMSes, notes apps with real version history, lightweight code forges, or agent sandboxes with auditable file history.

## Install

```bash
npm install @nandan-varma/git-fs-s3 isomorphic-git
# for the S3 store (any S3-compatible provider):
npm install @aws-sdk/client-s3
```

## Quick start

### Cloudflare R2 / AWS S3 / MinIO

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import git from "isomorphic-git";
import { createCachedStore, createGitFs } from "@nandan-varma/git-fs-s3";
import { S3ObjectStore } from "@nandan-varma/git-fs-s3/s3";

const store = new S3ObjectStore({
  client: new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT, // omit for AWS S3
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  }),
  bucket: "my-git-repos",
});

const fs = createGitFs(createCachedStore(store), {
  prefix: "repos/alice/blog",
});

// The bucket now behaves like a directory containing a bare repo:
await git.init({ fs, gitdir: "/git", bare: true, defaultBranch: "main" });
const oid = await git.resolveRef({ fs, gitdir: "/git", ref: "main" });
const log = await git.log({ fs, gitdir: "/git", ref: "main" });
```

### In memory (tests, examples)

```typescript
import git from "isomorphic-git";
import { createGitFs, MemoryObjectStore } from "@nandan-varma/git-fs-s3";

const fs = createGitFs(new MemoryObjectStore());
await git.init({ fs, gitdir: "/repo.git", bare: true });
```

### Any other storage

Implement the five-method `ObjectStore` interface (`get`, `put`, `delete`, `head`, `list`) and pass it to `createGitFs` — that's the whole contract. Google Cloud Storage, Azure Blob, a database, anything.

## Production stack

The stores compose as decorators. For a serving path that hits object storage hundreds of times per page, stack them in this order — retry closest to the network so the cache never stores transient failures and coalesced callers share one retried request:

```typescript
import {
  createCachedStore,
  createGitFs,
  createRetryStore,
} from "@nandan-varma/git-fs-s3";
import { S3ObjectStore } from "@nandan-varma/git-fs-s3/s3";

const store = createCachedStore(
  createRetryStore(
    new S3ObjectStore({
      client,
      bucket: "my-git-repos",
      // cosmetic: keeps refs/config human-readable in bucket UIs
      contentType: (key) =>
        /\/(HEAD|config)$|\/refs\//.test(key) ? "text/plain" : undefined,
    }),
  ),
  {
    maxBytes: 256 * 1024 * 1024,
    ttlMs: 3_600_000,
    cacheMisses: true, // loose-object probes on packed repos are ~always misses
    cacheLists: true,  // caches readdir + existence probes
  },
);

const fs = createGitFs(store, {
  looseObjectHints: true,
  // paths git probes constantly but this backend never writes:
  isStructurallyAbsent: (p) => /(^|\/)git\/(packed-refs|shallow)$/.test(p),
});

// Before a full-history walk (commit log, reachability traversal):
await fs.detectLooseObjects(gitdir);   // one bounded LIST per repo
await fs.prefetchPacks(gitdir);        // parallel pack warm-up

// After anything writes to the bucket *around* this fs (a hydrate/sync
// pipeline, a bulk upload, another process): drop the affected state, or
// reads can stay stale for up to ttlMs.
fs.invalidate("repos/alice/blog");
```

## API

### `createGitFs(store, options?)`

Returns a promise-based fs client for isomorphic-git's `fs` option, plus git-aware maintenance methods.

- `options.prefix` — key prefix all paths resolve under (e.g. `"repos/alice/blog"`). Paths that would traverse above it throw `EINVAL`.
- `options.looseObjectHints` — remember, per gitdir, whether any loose objects exist so fully packed repos skip every guaranteed-miss loose read. Hints are only created by `detectLooseObjects`; a loose write flips them back instantly, so they can't go stale mid-push. Default off.
- `options.isStructurallyAbsent(path)` — paths that are known never to exist answer `ENOENT` with zero store calls (e.g. `packed-refs`/`shallow` under your gitdir layout). Match precisely — `refs/heads/packed-refs` is a legal branch.
- `options.hintTtlMs` — loose-hint TTL, default 1 h. `options.onNote` — diagnostic sink.

The returned fs also exposes:

- `detectLooseObjects(gitdir)` — one bounded LIST that registers the loose-object hint; call before full-history walks.
- `prefetchPacks(gitdir, { maxPacks? })` — warm all pack files in parallel before a sequential walk (skipped past `maxPacks * 2` entries).
- `invalidate(pathPrefix)` — drop hints under the prefix and forward to the store's `invalidate` if it has one.

### `S3ObjectStore({ client, bucket, prefix?, contentType? })`

`ObjectStore` over `@aws-sdk/client-s3` (optional peer dependency, loaded only via the `/s3` subpath). Reuse one `S3Client` across stores so HTTP connections are pooled — a busy repo page can mean hundreds of object reads. `contentType(key)` optionally derives a `Content-Type` header for uploads.

### `MemoryObjectStore()`

In-memory store; also the reference implementation of list/delimiter semantics.

### `createCachedStore(store, options?)`

Wraps any store with an in-process LRU read cache (git objects are content-addressed, so they cache perfectly; refs expire on `ttlMs`). Returns a `CachedObjectStore` with an `invalidate(prefix)` method.

- `maxBytes` — cache budget, default 50 MiB. `maxEntryBytes` — largest admissible entry, default a tenth of `maxBytes`, so one huge pack can't evict the working set.
- `ttlMs` — entry TTL, default 60 s
- `cacheMisses` — also cache "not found" results. Big win for loose-object probes on packed repos; only safe when this process is the sole writer.
- `cacheLists` — also cache `list()` results (readdir + existence probes). Writes through the store keep listings consistent, with one deliberate asymmetry: a non-empty `limit: 1` probe ("this directory exists") survives writes underneath it, since a write can't make a directory stop existing. After external writes, call `invalidate(prefix)`.
- `coalesce` — collapse concurrent `get`/`head`/`list` calls for the same key into one backend request. Default on.
- `onHit(key)` / `onMiss(key)` — instrumentation hooks.

**Staleness contract:** `cacheMisses`/`cacheLists` trade read traffic for a window (bounded by `ttlMs`) in which another process's writes are invisible. Fine when each repo has one serving process, or when every external write path calls `invalidate()`.

### `createRetryStore(store, options?)`

Wraps any store with exponential-backoff retries and a per-instance circuit breaker. Place it directly above the network store, under the cache.

- `retries` (3), `initialDelayMs` (100), `maxDelayMs` (5000), `jitter` (0.3)
- `isRetryable(error)` — default retries network faults, throttling, and HTTP 5xx/429
- `breaker` — `{ threshold: 5, resetMs: 30_000 }` by default, or `false` to disable. While open, calls fail fast with `CircuitOpenError` (`code: "EUNAVAILABLE"`).
- `onRetry(info)` — logging hook.

## Semantics & limitations

- **Bare repositories are the target.** Plumbing (`writeBlob`/`writeTree`/`writeCommit`/`readCommit`/`log`/refs/branches) is covered by the test suite. Worktree operations (`checkout`, `add`, `status`) want a real disk — hydrate to `/tmp` for those.
- Directories are implicit (`mkdir` no-op, a dir exists when keys live under it), like object storage itself.
- Symlinks are unsupported (`readlink`→`ENOENT`, `symlink`→`EPERM`); bare repos don't contain them.
- Object storage has no rename and no atomic multi-key transactions. Concurrent pushes to the same repo need external serialization (a lock or single-writer queue).

## Roadmap

- Git smart-HTTP protocol handler (`upload-pack`/`receive-pack`) as a Fetch-API handler
- More stores out of the box

## License

[MIT](LICENSE)
