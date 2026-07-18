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

## API

### `createGitFs(store, options?)`

Returns a promise-based fs client for isomorphic-git's `fs` option.

- `options.prefix` — key prefix all paths resolve under (e.g. `"repos/alice/blog"`). Paths that would traverse above it throw `EINVAL`.

### `S3ObjectStore({ client, bucket, prefix? })`

`ObjectStore` over `@aws-sdk/client-s3` (optional peer dependency, loaded only via the `/s3` subpath). Reuse one `S3Client` across stores so HTTP connections are pooled — a busy repo page can mean hundreds of object reads.

### `MemoryObjectStore()`

In-memory store; also the reference implementation of list/delimiter semantics.

### `createCachedStore(store, options?)`

Wraps any store with an in-process LRU read cache (git objects are content-addressed, so they cache perfectly; refs expire on `ttlMs`).

- `maxBytes` — cache budget, default 50 MiB
- `ttlMs` — entry TTL, default 60 s
- `cacheMisses` — also cache "not found" results. Big win for loose-object probes on packed repos; only safe when this process is the sole writer.

## Semantics & limitations

- **Bare repositories are the target.** Plumbing (`writeBlob`/`writeTree`/`writeCommit`/`readCommit`/`log`/refs/branches) is covered by the test suite. Worktree operations (`checkout`, `add`, `status`) want a real disk — hydrate to `/tmp` for those.
- Directories are implicit (`mkdir` no-op, a dir exists when keys live under it), like object storage itself.
- Symlinks are unsupported (`readlink`→`ENOENT`, `symlink`→`EPERM`); bare repos don't contain them.
- Object storage has no rename and no atomic multi-key transactions. Concurrent pushes to the same repo need external serialization (a lock or single-writer queue).

## Roadmap

- Git smart-HTTP protocol handler (`upload-pack`/`receive-pack`) as a Fetch-API handler
- Packfile-aware read path optimizations (loose-object presence hints)
- More stores out of the box

## License

[MIT](LICENSE)
