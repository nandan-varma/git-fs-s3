import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { createGitFs, MemoryObjectStore, createCachedStore } from "./dist/index.js";
import { collectReachableOids } from "./dist/http.js";
const root = "/private/tmp/claude-501/-Users-nandan-dev-pushstack/329b1d61-4a92-4910-bbf8-2f059d55b042/scratchpad/realrepo";
const store = new MemoryObjectStore();
function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else store.put("g/" + p.slice(root.length + 1), readFileSync(p)); } }
walk(root);
const cached = createCachedStore(store, { maxBytes: 1e9, cacheLists: true, cacheMisses: true, copy: false });
const repo = { fs: createGitFs(cached, { looseObjectHints: true }), gitdir: "g", cache: {} };
const head = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
for (let i = 0; i < 2; i++) { const t = performance.now(); const r = await collectReachableOids(repo, [head], undefined, undefined, { verifyBlobs: false }); console.log("walk", r.oids.length, Math.round(performance.now() - t), "ms"); }
let t = performance.now(); const r = await collectReachableOids(repo, [head], undefined, undefined, { verifyBlobs: false });
t = performance.now(); await git.packObjects({ ...repo, oids: r.oids }); console.log("packObjects", Math.round(performance.now() - t), "ms");
