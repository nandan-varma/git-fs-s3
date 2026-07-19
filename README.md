# git-fs-s3

[![npm version](https://img.shields.io/npm/v/@nandan-varma/git-fs-s3.svg)](https://www.npmjs.com/package/@nandan-varma/git-fs-s3)
[![CI](https://github.com/nandan-varma/git-fs-s3/actions/workflows/ci.yml/badge.svg)](https://github.com/nandan-varma/git-fs-s3/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@nandan-varma/git-fs-s3.svg)](LICENSE)

An [isomorphic-git](https://isomorphic-git.org) filesystem backend for S3-compatible object storage — AWS S3, Cloudflare R2, MinIO, Backblaze B2. Run git repositories on serverless platforms with **no disk, no git binary, and no state between invocations**.

```
isomorphic-git  ──fs──►  git-fs-s3  ──►  ObjectStore  ──►  S3 / R2 / MinIO / memory
```

Extracted from the git layer of a production git-hosting service, where it serves clones, pushes, and repo browsing directly against Cloudflare R2 from Vercel functions. Three layers, usable independently:

- **root export** — the fs backend itself (`createGitFs`, stores, caching).
- **`/http`** — a git smart-HTTP protocol handler (`upload-pack`/`receive-pack`) built on it.
- **`/ops`** — higher-level git-hosting operations (branches, commits, diffs, history, merge) built on top of that.

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
    // refs and the objects/pack listing are the mutable parts of a gitdir —
    // give them a short override instead of the long ttlMs above, or a warm
    // process can keep serving a pre-push ref (or fail to notice a freshly
    // pushed pack exists at all) for the rest of ttlMs. Cheap: both are one
    // small object or a bounded listing.
    ttlForKey: (key) =>
      /\/(HEAD|refs(\/|$)|objects\/(pack\/)?$)/.test(key) ? 5_000 : undefined,
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

Wraps any store with an in-process LRU read cache (git objects are content-addressed, so they cache perfectly; refs and directory listings are mutable and should use a shorter override — see `ttlForKey`). Returns a `CachedObjectStore` with an `invalidate(prefix)` method.

- `maxBytes` — cache budget, default 50 MiB. `maxEntryBytes` — largest admissible entry, default a tenth of `maxBytes`, so one huge pack can't evict the working set.
- `ttlMs` — entry TTL, default 60 s
- `ttlForKey(key)` — per-key/prefix TTL override in ms (applies to `get`/`head`/`list`); return `undefined` to fall back to `ttlMs`. A single long `ttlMs` is right for content-addressed object keys (the same key's bytes never change) but wrong for mutable ones — a ref's value moves on every push, and a directory listing (`objects/pack/`) grows on every push, while the *key* naming them stays the same. This cache is in-process with no cross-instance invalidation, so without an override a warm instance that already cached a ref, or a pack directory's listing, can keep serving that pre-push view for the rest of `ttlMs` even though nothing is wrong with its own invalidation logic — it just never re-checked. See the [caching guide](https://nandan-varma.github.io/git-fs-s3/guides/caching/) for the full reasoning.
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

## Git smart-HTTP

`@nandan-varma/git-fs-s3/http` implements the git smart-HTTP protocol (`info/refs`, `upload-pack`, `receive-pack`) as plain functions over a `Repo` — no framework assumptions, Fetch-API-shaped inputs/outputs. Extracted from the same production git-hosting service's HTTP layer, so it's what actually serves `git clone`/`git push` over HTTPS: pkt-line framing, side-band-64k packfile chunking (required once a client like isomorphic-git negotiates it — it always demuxes the response), CAS-checked ref updates, and pack consolidation.

```typescript
import {
  handleInfoRefs,
  handleUploadPack,
  parseReceivePackBody,
  applyReceivePack,
  receivePackResponse,
} from "@nandan-varma/git-fs-s3/http";

// GET .../info/refs?service=git-upload-pack — auth/authz is the caller's job
export async function infoRefs(repo: Repo, service: "git-upload-pack" | "git-receive-pack") {
  const { status, headers, body } = await handleInfoRefs(repo, { service });
  return new Response(body, { status, headers });
}

// POST .../git-upload-pack (clone/fetch)
export async function uploadPack(repo: Repo, request: Request) {
  const body = new Uint8Array(await request.arrayBuffer());
  const { status, headers, body: respBody } = await handleUploadPack(repo, body);
  return new Response(respBody, { status, headers });
}

// POST .../git-receive-pack (push)
export async function receivePack(repo: Repo, request: Request) {
  const body = new Uint8Array(await request.arrayBuffer());
  const { results, stalePackPaths } = await applyReceivePack(
    repo,
    parseReceivePackBody(body),
    { repack: { threshold: 4 } }, // or false to never auto-consolidate
  );
  // stalePackPaths were removed locally by the repack — delete them from any
  // secondary storage this repo also lives in, same as you'd invalidate a cache.
  const { status, headers, body: respBody } = receivePackResponse(results);
  return new Response(respBody, { status, headers });
}
```

Every client-supplied ref name in a push is validated with `isSafeFullRefName` (from the top-level export, see below) *inside* `applyRefUpdates`/`applyReceivePack` before it reaches any filesystem call — `git.commit`/`git.merge`/`git.deleteBranch` and the raw `git.resolveRef`/`git.deleteRef`/`git.writeRef` isomorphic-git calls this module uses internally do **not** validate ref names themselves (only `git.branch` and the top-level `git.writeRef` do), so an unvalidated `"../"`-laden ref name is a cross-repo path traversal on any shared-storage server. If you build additional git-touching endpoints on top of this package, run ref/branch names from request input through `isSafeFullRefName`/`isSafeBranchName`/`isSafeRefName`/`isSafeRepoPath` yourself first.

`HttpHooks` (`{ step?, onWarn? }`), accepted by every handler, is the instrumentation seam: `step(label, fn)` wraps a timed sub-step — drop in an app's own request-scoped timer — and `onWarn(message, error)` surfaces non-fatal problems (a missing object during a reachability walk, a failed repack). `handleUploadPack`'s `beforeWalk` option is where to wire loose-object detection (`GitFs.detectLooseObjects`, above) so a fully packed repo's reachability walk doesn't pay a doomed loose-object probe per object.

`repackRepository(repo, options?, hooks?)` — also exported standalone for out-of-band maintenance (clearing a backlog outside a live push) — consolidates all packs into one once `objects/pack/` crosses `options.threshold` (default `REPACK_PACK_COUNT_THRESHOLD = 4`) packs, verifying every object's SHA-1 independently before writing (isomorphic-git's *packed*-object read path never checks a resolved delta's content against the requested oid — only the loose-object branch does). Returns the gitdir-relative paths of the `.pack`/`.idx` files it removed locally; if this repo's storage is also synced elsewhere, delete those same paths there too, or a reader served by the stale copy re-fetches objects that are gone from the pack it expects them in.

## App-layer git operations

`@nandan-varma/git-fs-s3/ops` is a higher-level layer for building a git-hosting UI on top of `createGitFs` — the operations a repo browser / PR flow actually needs, each taking a `Repo` (`{ fs, gitdir, cache? }`) plus an optional `OpsHooks` (`{ resultCache?, step?, onNote?, prefetchPacks? }`) for the same timing/caching seam `GitFs` and `/http` use:

- **Branches** — `listBranches`, `createBranchFrom`, `deleteBranchByName`.
- **Commits** — `commitFilesToBare` (write one or more files as a single commit against a branch, creating it if new), `deleteFileFromBare`, `authorNow`.
- **Trees** — `upsertTree`/`deleteFromTree` (overlay blobs onto a tree, return the new root oid), `listTreeEntries`, `findTreeEntry`.
- **History** — `getCommitLog`/`getCommitHistory` (cached, resumable commit-chain walks — reuses a previously-walked prefix instead of re-walking from HEAD), `getFileContent`/`getFileFromRef`/`getTreeFromRef`, `getFileHistory` (per-file commit history), `getLastCommitsForTree` (the "last commit" column on a directory listing, batched two-phase prefetch-then-resolve).
- **Diff** — `getCommitDiff`/`getDiffBetweenRefs`, unified-diff patches via the `diff` package (optional peer dependency).
- **Merge** — `analyzeMerge` (fast-forward/diverged pre-check — not a real content-conflict check, see its doc comment) and `fastForwardMerge`.

```typescript
import { commitFilesToBare, authorNow, getCommitLog } from "@nandan-varma/git-fs-s3/ops";

await commitFilesToBare(repo, {
  branch: "main",
  message: "Update README",
  author: authorNow("Ada", "ada@example.com"),
  files: [{ path: "README.md", content: "# hello\n" }],
});

const { entries } = await getCommitLog(repo, { ref: "main", depth: 50 });
```

`resultKeyPrefixes` (from `/ops`) lists the `ResultCache` key prefixes these functions write under — evict them after rewriting a repo's storage out of band (bulk sync, rename), or a cached walk result outlives the history it describes.

## Semantics & limitations

- **Bare repositories are the target.** Plumbing (`writeBlob`/`writeTree`/`writeCommit`/`readCommit`/`log`/refs/branches) is covered by the test suite. Worktree operations (`checkout`, `add`, `status`) want a real disk — hydrate to `/tmp` for those.
- Directories are implicit (`mkdir` no-op, a dir exists when keys live under it), like object storage itself.
- Symlinks are unsupported (`readlink`→`ENOENT`, `symlink`→`EPERM`); bare repos don't contain them.
- Object storage has no rename and no atomic multi-key transactions. Concurrent pushes to the same repo need external serialization (a lock or single-writer queue).

## Roadmap

- More stores out of the box (Google Cloud Storage, Azure Blob)

## License

[MIT](LICENSE)
