import git from "isomorphic-git";
import { concat } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import { packFileName, parsePackDirectory } from "../pack-files.js";
import { listAllRefs } from "./info-refs.js";
import { buildPackFromExistingPacks, readPackIndex } from "./pack-reuse.js";
import { parsePktLines, pktLine, sideBandPackfile } from "./pkt-line.js";
import { collectCommitAncestry, collectReachableOids } from "./reachability.js";
import { type GitHttpResult, type HttpHooks, rawFs, runStep } from "./types.js";

const ZERO_OID = "0".repeat(40);

export interface UploadPackOptions {
	/**
	 * Called once before the reachability walk — wire loose-object detection
	 * (`GitFs.detectLooseObjects`) here so a fully packed repo's walk doesn't
	 * pay a doomed loose-object probe per object.
	 */
	beforeWalk?: () => Promise<void>;
}

/**
 * `POST …/git-upload-pack` — serve a clone/fetch. Authorization is the
 * caller's job. Negotiation is client-driven (no multi_ack advertised):
 * "have" batches without "done" get a bare NAK; the final batch gets the
 * packfile, side-band-64k framed.
 *
 * Fast path: a fresh clone (no haves) of a repo consolidated down to a
 * single pack serves that pack's bytes directly — skipping the O(objects)
 * traversal + repack entirely.
 */
const OID_RE = /^[0-9a-f]{40}$/;
const LOOSE_FANOUT_RE = /^[0-9a-f]{2}$/;

function result(body: Uint8Array<ArrayBuffer>): GitHttpResult {
	return {
		status: 200,
		headers: {
			"Content-Type": "application/x-git-upload-pack-result",
			"Cache-Control": "no-cache",
		},
		body,
	};
}

/** A protocol-level error the client prints ("ERR …"), not an HTTP failure. */
function errorResult(message: string): GitHttpResult {
	return result(pktLine(`ERR ${message}\n`));
}

/** Parsed upload-pack request: oids are always 40 lowercase hex digits. */
export function parseUploadPackRequest(body: Uint8Array): {
	wants: string[];
	haves: string[];
	done: boolean;
	capabilities: string[];
	invalid: boolean;
} {
	const wants: string[] = [];
	const haves: string[] = [];
	let done = false;
	let invalid = false;
	let capabilities: string[] | undefined;
	for (const line of parsePktLines(body)) {
		if (!line) continue;
		const text = line.replace(/\n$/, "");
		if (text.startsWith("want ")) {
			const [oid, ...caps] = text.slice(5).split(" ");
			if (capabilities === undefined) capabilities = caps.filter(Boolean);
			if (oid !== undefined && OID_RE.test(oid)) wants.push(oid);
			else invalid = true;
		} else if (text.startsWith("have ")) {
			const oid = text.slice(5).trim();
			if (OID_RE.test(oid)) {
				if (oid !== ZERO_OID) haves.push(oid);
			} else {
				invalid = true;
			}
		} else if (text === "done") {
			done = true;
		}
	}
	return {
		wants: [...new Set(wants)],
		haves: [...new Set(haves)],
		done,
		capabilities: capabilities ?? [],
		invalid,
	};
}

/**
 * The single pack a fresh clone can be served verbatim, or null. Only safe
 * when nothing lives outside it (no loose objects, exactly one pack) and it
 * holds every wanted object — a repo with commits written as loose objects
 * after its last repack would otherwise clone incomplete.
 */
async function servableSinglePack(
	repo: Repo,
	wants: readonly string[],
	hooks?: HttpHooks,
): Promise<Uint8Array | null> {
	const fsp = rawFs(repo);
	const objectsDir = `${repo.gitdir}/objects`;
	const [objectEntries, packEntries] = await runStep(
		hooks,
		"readdir objects + objects/pack",
		() =>
			Promise.all([
				fsp.readdir(objectsDir).catch(() => [] as string[]),
				fsp.readdir(`${objectsDir}/pack`).catch(() => [] as string[]),
			]),
	);
	if (objectEntries.some((name) => LOOSE_FANOUT_RE.test(name))) return null;
	const packs = parsePackDirectory(packEntries).filter(
		(file) => file.kind === "pack",
	);
	const pack = packs[0];
	if (packs.length !== 1 || pack === undefined) return null;
	const [packData, idxData] = await runStep(
		hooks,
		"read consolidated pack (fast path)",
		() =>
			Promise.all([
				fsp.readFile(`${objectsDir}/pack/${pack.name}`),
				fsp.readFile(`${objectsDir}/pack/${packFileName(pack.base, "idx")}`),
			]).catch(() => [null, null] as const),
	);
	if (!(packData instanceof Uint8Array) || !(idxData instanceof Uint8Array)) {
		return null;
	}
	const indexed = readPackIndex(idxData);
	if (!indexed) return null;
	const oids = new Set(indexed.map((entry) => entry.oid));
	return wants.every((oid) => oids.has(oid)) ? packData : null;
}

/**
 * `POST …/git-upload-pack` — serve a clone/fetch. Authorization is the
 * caller's job. Negotiation is client-driven (no multi_ack advertised):
 * "have" batches without "done" get a bare NAK; the final batch gets the
 * packfile, side-band-64k framed when the client asked for it.
 *
 * Only objects reachable from the repository's refs are served: a want that
 * isn't a ref tip must be an ancestor of one ("not our ref" otherwise), so a
 * force-pushed-away commit still sitting in a pack can't be fetched by id.
 *
 * A fetch with haves reads only the client's commit ancestry plus the trees
 * of the boundary commits (the haves the new history builds on) — not every
 * tree the client already has.
 *
 * Fast path: a fresh clone (no haves) of a repo consolidated down to a
 * single pack, with no loose objects, serves that pack's bytes directly —
 * skipping the O(objects) traversal + repack entirely.
 */
export async function handleUploadPack(
	repo: Repo,
	body: Uint8Array,
	options?: UploadPackOptions,
	hooks?: HttpHooks,
): Promise<GitHttpResult> {
	const request = parseUploadPackRequest(body);
	if (request.invalid) {
		return errorResult("upload-pack: protocol error, malformed object id");
	}
	const { wants, haves, done, capabilities } = request;
	const frame = (pack: Uint8Array) =>
		capabilities.includes("side-band-64k") || capabilities.includes("side-band")
			? sideBandPackfile(pack)
			: concat(pack);

	if (wants.length === 0 || (haves.length > 0 && !done)) {
		return result(concat(pktLine("NAK\n")));
	}

	const { refs } = await runStep(hooks, "listAllRefs", () =>
		listAllRefs(repo, "HEAD"),
	);
	const tips = new Set(refs.map((ref) => ref.oid));
	const untipped = wants.filter((oid) => !tips.has(oid));
	if (untipped.length > 0) {
		const { commits } = await runStep(hooks, "verify wants reachable", () =>
			collectCommitAncestry(repo, [...tips]),
		);
		const missing = untipped.find((oid) => !commits.has(oid));
		if (missing !== undefined) {
			return errorResult(`upload-pack: not our ref ${missing}`);
		}
	}

	if (haves.length === 0) {
		const pack = await servableSinglePack(repo, wants, hooks);
		if (pack) return result(concat(pktLine("NAK\n"), frame(pack)));
	}

	if (options?.beforeWalk) {
		await runStep(hooks, "beforeWalk", options.beforeWalk);
	}

	let haveSet: Set<string> | undefined;
	if (haves.length > 0) {
		haveSet = await runStep(hooks, "have boundary", async () => {
			// Everything the client has: its commits' whole ancestry (commits
			// only), plus the full content of the commits our new history
			// builds on. Objects only older commits share may be re-sent —
			// git's own boundary approximation; never anything missing.
			const { commits: clientCommits } = await collectCommitAncestry(
				repo,
				haves,
			);
			const { boundary } = await collectCommitAncestry(
				repo,
				wants,
				clientCommits,
			);
			const boundaryTrees = await Promise.all(
				[...boundary].map(async (oid) => {
					const { commit } = await git.readCommit({ ...repo, oid });
					return commit.tree;
				}),
			);
			const { oids: boundaryObjects } = await collectReachableOids(
				repo,
				boundaryTrees,
				hooks,
				undefined,
				{ verifyBlobs: false },
			);
			return new Set([...clientCommits, ...boundaryObjects]);
		});
	}

	const { oids: wantOids, complete } = await runStep(
		hooks,
		"collectReachableOids(wants)",
		() =>
			collectReachableOids(repo, wants, hooks, haveSet, {
				verifyBlobs: false,
			}),
	);
	if (!complete) {
		return errorResult("upload-pack: repository is missing objects");
	}
	// Boundary oids are recorded as seen by the walk; drop them from the pack.
	const oids = haveSet ? wantOids.filter((oid) => !haveSet.has(oid)) : wantOids;

	// Copy stored (already compressed, possibly deltified) entries when every
	// object is packed; build from scratch only when some aren't.
	const reused = await runStep(
		hooks,
		`reuse pack entries (${oids.length} oids)`,
		() => buildPackFromExistingPacks(repo, oids),
	);
	const packBytes =
		reused ??
		(await runStep(hooks, `packObjects (${oids.length} oids)`, async () => {
			const { packfile } = await git.packObjects({ ...repo, oids });
			return packfile instanceof Uint8Array
				? packfile
				: new Uint8Array(packfile ?? []);
		}));

	return result(concat(pktLine("NAK\n"), frame(packBytes)));
}
