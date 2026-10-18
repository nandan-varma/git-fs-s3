import git from "isomorphic-git";
import { concat, decodeAscii, decodeUtf8 } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import { storePack } from "../pack-write.js";
import { isSafeFullRefName } from "../refs.js";
import { FLUSH, pktLine, sideBandPackfile } from "./pkt-line.js";
import { collectReachableOids } from "./reachability.js";
import { type RepackOptions, repackRepository } from "./repack.js";
import { type GitHttpResult, type HttpHooks, rawFs, runStep } from "./types.js";

const ZERO_OID = "0".repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;

export interface RefUpdateCommand {
	oldOid: string;
	newOid: string;
	refName: string;
}

export interface RefUpdateResult {
	refName: string;
	ok: boolean;
	reason?: string;
}

export interface ParsedReceivePack {
	refUpdates: RefUpdateCommand[];
	packData: Uint8Array;
	/** Capabilities the client asked for on its first command line. */
	capabilities: string[];
}

/**
 * Split a receive-pack body: pkt-line ref commands, flush, then raw PACK.
 * A command whose oids aren't 40 lowercase hex digits is dropped — it can
 * never be applied, and its oids would otherwise reach object-path lookups.
 */
export function parseReceivePackBody(body: Uint8Array): ParsedReceivePack {
	const refUpdates: RefUpdateCommand[] = [];
	let capabilities: string[] | undefined;
	let pos = 0;
	while (pos + 4 <= body.length) {
		const len = Number.parseInt(decodeAscii(body.subarray(pos, pos + 4)), 16);
		if (len === 0) {
			pos += 4;
			break; // flush = end of ref update commands
		}
		if (len < 4) break;
		// The first command line carries NUL-separated capabilities.
		const [line, caps] = decodeUtf8(body.subarray(pos + 4, pos + len))
			.replace(/\n$/, "")
			.split("\0");
		if (capabilities === undefined) {
			capabilities = (caps ?? "").split(" ").filter(Boolean);
		}
		pos += len;
		const [oldOid, newOid, refName] = (line ?? "").split(" ");
		if (
			oldOid &&
			newOid &&
			refName &&
			OID_RE.test(oldOid) &&
			OID_RE.test(newOid)
		) {
			refUpdates.push({ oldOid, newOid, refName });
		}
	}
	return {
		refUpdates,
		packData: body.subarray(pos),
		capabilities: capabilities ?? [],
	};
}

/** Initialize the repo when its HEAD doesn't exist yet (first push). */
export async function ensureRepoInitialized(
	repo: Repo,
	defaultBranch: string,
): Promise<void> {
	const fsp = rawFs(repo);
	try {
		await fsp.stat(`${repo.gitdir}/HEAD`);
	} catch {
		await fsp.mkdir(repo.gitdir, { recursive: true }).catch(() => {});
		await git.init({ ...repo, dir: repo.gitdir, defaultBranch, bare: true });
	}
}

/** Write the incoming PACK into objects/pack/ and index it. */
export async function indexIncomingPack(
	repo: Repo,
	packData: Uint8Array,
	hooks?: HttpHooks,
): Promise<string[]> {
	if (packData.length < 4) return [];
	const packName = await runStep(
		hooks,
		"write + indexPack incoming pack",
		async () => {
			// Named by checksum (`pack-<sha>`), stored pack first, index last.
			const { base } = await storePack(repo, packData);
			return base;
		},
	);
	return [
		`${repo.gitdir}/objects/pack/${packName}.pack`,
		`${repo.gitdir}/objects/pack/${packName}.idx`,
	];
}

/**
 * Validate a ref name and compare-and-swap it against its claimed current
 * oid. Returns the failure result to report if either check fails, or
 * `null` when both pass — shared by the preflight check (`validateRefUpdates`,
 * run before the possibly-slow pack indexing/graph-walk work, purely to
 * avoid doing that work for an update already doomed to fail) and the real
 * atomicity guarantee (`applyRefUpdates`, run again right before writing,
 * since a concurrent push could have moved the ref in the time that work
 * took).
 */
async function checkRefCas(
	repo: Repo,
	refName: string,
	oldOid: string,
): Promise<RefUpdateResult | null> {
	if (!isSafeFullRefName(refName)) {
		return { refName, ok: false, reason: "invalid ref name" };
	}
	const currentOid = await git
		.resolveRef({ ...repo, ref: refName })
		.catch(() => ZERO_OID);
	return currentOid === oldOid
		? null
		: {
				refName,
				ok: false,
				reason: "non-fast-forward, ref updated by another push",
			};
}

/** Every branch/tag tip currently in the repo, as a validation boundary — see
 * its call site in {@link applyReceivePack}. */
async function collectExistingRefTips(repo: Repo): Promise<Set<string>> {
	const [branches, tags] = await Promise.all([
		git.listBranches(repo),
		git.listTags(repo),
	]);
	const refs = [
		...branches.map((b) => `refs/heads/${b}`),
		...tags.map((t) => `refs/tags/${t}`),
	];
	const oids = await Promise.all(
		refs.map((ref) => git.resolveRef({ ...repo, ref }).catch(() => null)),
	);
	return new Set(oids.filter((oid): oid is string => oid !== null));
}

/** The branch HEAD names, or null when HEAD is detached/unreadable. */
async function currentBranchRef(repo: Repo): Promise<string | null> {
	return git
		.currentBranch({ ...repo, fullname: true })
		.then((ref) => ref ?? null)
		.catch(() => null);
}

async function validateRefUpdates(
	repo: Repo,
	refUpdates: RefUpdateCommand[],
): Promise<RefUpdateResult[]> {
	const headRef = await currentBranchRef(repo);
	const seen = new Set<string>();
	return Promise.all(
		refUpdates.map(async ({ oldOid, newOid, refName }) => {
			// Two commands for one ref can't both be compare-and-swapped.
			if (seen.has(refName)) {
				return { refName, ok: false, reason: "duplicate ref update" };
			}
			seen.add(refName);
			// Same rule as git's receive.denyDeleteCurrent: deleting the
			// branch HEAD names leaves every clone without a default branch.
			if (newOid === ZERO_OID && refName === headRef) {
				return {
					refName,
					ok: false,
					reason: "deletion of the current branch prohibited",
				};
			}
			return (
				(await checkRefCas(repo, refName, oldOid)) ?? { refName, ok: true }
			);
		}),
	);
}

/**
 * Apply ref updates, enforcing compare-and-swap against each command's
 * claimed oldOid. Every client-supplied refName is validated before any
 * filesystem call reads or writes through it.
 */
export async function applyRefUpdates(
	repo: Repo,
	refUpdates: RefUpdateCommand[],
	hooks?: HttpHooks,
): Promise<RefUpdateResult[]> {
	return runStep(hooks, "apply ref updates", () =>
		Promise.all(
			refUpdates.map(async ({ oldOid, newOid, refName }) => {
				const failure = await checkRefCas(repo, refName, oldOid);
				if (failure) return failure;

				if (newOid === ZERO_OID) {
					await git.deleteRef({ ...repo, ref: refName }).catch(() => {});
				} else {
					// A branch must name a commit; a tag may name anything.
					if (refName.startsWith("refs/heads/")) {
						const { type } = await git
							.readObject({ ...repo, oid: newOid, format: "content" })
							.catch(() => ({ type: "missing" }));
						if (type !== "commit") {
							return {
								refName,
								ok: false,
								reason: `branch must point at a commit, not a ${type}`,
							};
						}
					}
					await git.writeRef({
						...repo,
						ref: refName,
						value: newOid,
						force: true,
					});
				}
				return { refName, ok: true };
			}),
		),
	);
}

/**
 * The report-status response for a set of ref-update results — empty unless
 * the client asked for `report-status`, and side-band-64k framed when it
 * asked for that (git and isomorphic-git both do; isomorphic-git always
 * demuxes the response as side-band). `unpackError` reports a pack that
 * couldn't be stored or indexed.
 */
export function receivePackResponse(
	results: RefUpdateResult[],
	options?: { capabilities?: readonly string[]; unpackError?: string },
): GitHttpResult {
	const capabilities = options?.capabilities ?? ["report-status"];
	const report = capabilities.includes("report-status")
		? concat(
				pktLine(
					options?.unpackError
						? `unpack ${options.unpackError}\n`
						: "unpack ok\n",
				),
				...results.map(({ refName, ok, reason }) =>
					pktLine(ok ? `ok ${refName}\n` : `ng ${refName} ${reason}\n`),
				),
				FLUSH,
			)
		: new Uint8Array();
	const responseBody =
		capabilities.includes("side-band-64k") && report.length > 0
			? sideBandPackfile(report)
			: report;

	return {
		status: 200,
		headers: {
			"Content-Type": "application/x-git-receive-pack-result",
			"Cache-Control": "no-cache",
		},
		body: responseBody,
	};
}

export interface ApplyReceivePackOptions {
	/** HEAD's branch when a push initializes an empty repository. */
	defaultBranch: string;
	/**
	 * Repack tuning, or `false` to skip repacking entirely. The returned
	 * `stalePackPaths` are gitdir-relative pack files the repack deleted from
	 * this repo — after syncing to any secondary storage, delete them there
	 * too.
	 */
	repack?: RepackOptions | false;
}

/**
 * The storage half of a push against `repo`: initialize if needed, index the
 * incoming pack, CAS-apply ref updates, then repack when enough packs have
 * accumulated. Serialize concurrent pushes to the same repo externally (a
 * per-repo lock); build the HTTP response afterwards with
 * {@link receivePackResponse}.
 */
export interface ApplyReceivePackResult {
	results: RefUpdateResult[];
	stalePackPaths: string[];
	/** Set when the incoming pack couldn't be stored or indexed. */
	unpackError?: string;
}

export async function applyReceivePack(
	repo: Repo,
	parsed: { refUpdates: RefUpdateCommand[]; packData: Uint8Array },
	options: ApplyReceivePackOptions,
	hooks?: HttpHooks,
): Promise<ApplyReceivePackResult> {
	await ensureRepoInitialized(repo, options.defaultBranch);
	const preflight = await validateRefUpdates(repo, parsed.refUpdates);
	const acceptedUpdates = parsed.refUpdates.filter(
		(_, index) => preflight[index]?.ok,
	);
	const fsp = rawFs(repo);
	const packDir = `${repo.gitdir}/objects/pack`;
	const existingPacks = new Set(
		await fsp.readdir(packDir).catch(() => [] as string[]),
	);
	let incomingPackPaths: string[];
	try {
		incomingPackPaths = await indexIncomingPack(
			repo,
			acceptedUpdates.some((update) => update.newOid !== ZERO_OID)
				? parsed.packData
				: new Uint8Array(),
			hooks,
		);
	} catch (err) {
		hooks?.onWarn?.("receive-pack: incoming pack rejected", err);
		return {
			results: preflight.map((result) =>
				result.ok ? { ...result, ok: false, reason: "unpacker error" } : result,
			),
			stalePackPaths: [],
			unpackError: "index-pack failed",
		};
	}
	// A checksum-named pack identical to one already stored must survive the
	// cleanup below. Index first, so readers never see a half-removed pack.
	const removableIncoming = incomingPackPaths
		.filter((path) => !existingPacks.has(path.slice(packDir.length + 1)))
		.sort((a, b) => Number(b.endsWith(".idx")) - Number(a.endsWith(".idx")));

	const newTips = acceptedUpdates
		.filter((update) => update.newOid !== ZERO_OID)
		.map((update) => update.newOid);
	if (newTips.length > 0) {
		// Every oid reachable from an existing ref was already accepted by an
		// earlier push — not just the ref(s) this push happens to touch. A
		// brand-new branch (oldOid === ZERO_OID, so it has no pre-image of its
		// own) is the common case this matters for: creating a branch off an
		// existing one is still just one new commit's worth of new objects,
		// and shouldn't cost a walk of the entire repo history to validate.
		const haveOids = await collectExistingRefTips(repo);
		for (const update of acceptedUpdates) {
			if (update.oldOid !== ZERO_OID) haveOids.add(update.oldOid);
		}
		const { complete } = await collectReachableOids(
			repo,
			newTips,
			hooks,
			haveOids,
		);
		if (!complete) {
			for (const filepath of removableIncoming) {
				await fsp.unlink(filepath).catch(() => {});
			}
			return {
				results: preflight.map((result) =>
					result.ok
						? { ...result, ok: false, reason: "incomplete object graph" }
						: result,
				),
				stalePackPaths: [],
			};
		}
	}

	const applied = await applyRefUpdates(repo, acceptedUpdates, hooks);
	const results = preflight.map((result, index) =>
		result.ok
			? (applied.find(
					(entry) => entry.refName === parsed.refUpdates[index]?.refName,
				) ?? result)
			: result,
	);
	const repackOptions = options.repack;
	const stalePackPaths =
		repackOptions === false || !results.some((result) => result.ok)
			? []
			: await runStep(hooks, "repack", () =>
					repackRepository(repo, repackOptions, hooks),
				);
	return { results, stalePackPaths };
}
