import git from "isomorphic-git";
import { concat, decodeAscii, decodeUtf8 } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import { isSafeFullRefName } from "../refs.js";
import { FLUSH, pktLine } from "./pkt-line.js";
import { type RepackOptions, repackRepository } from "./repack.js";
import { type GitHttpResult, type HttpHooks, rawFs, runStep } from "./types.js";

const ZERO_OID = "0".repeat(40);

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

/** Split a receive-pack body: pkt-line ref commands, flush, then raw PACK. */
export function parseReceivePackBody(body: Uint8Array): {
	refUpdates: RefUpdateCommand[];
	packData: Uint8Array;
} {
	const refUpdates: RefUpdateCommand[] = [];
	let pos = 0;
	while (pos + 4 <= body.length) {
		const len = Number.parseInt(decodeAscii(body.subarray(pos, pos + 4)), 16);
		if (len === 0) {
			pos += 4;
			break; // flush = end of ref update commands
		}
		if (len < 4) break;
		// Strip NUL-separated capabilities from the first command line
		const line = decodeUtf8(body.subarray(pos + 4, pos + len))
			.replace(/\n$/, "")
			.split("\0")[0];
		pos += len;
		const parts = (line ?? "").split(" ");
		const [oldOid, newOid, refName] = parts;
		if (oldOid && newOid && refName) {
			refUpdates.push({ oldOid, newOid, refName });
		}
	}
	return { refUpdates, packData: body.subarray(pos) };
}

/** Initialize the repo when its HEAD doesn't exist yet (first push). */
export async function ensureRepoInitialized(
	repo: Repo,
	defaultBranch = "main",
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
): Promise<void> {
	if (packData.length < 4) return;
	await runStep(hooks, "write + indexPack incoming pack", async () => {
		const fsp = rawFs(repo);
		const packDir = `${repo.gitdir}/objects/pack`;
		await fsp.mkdir(packDir, { recursive: true });

		const packName = `recv-${Date.now()}`;
		await fsp.writeFile(`${packDir}/${packName}.pack`, packData);

		await git.indexPack({
			...repo,
			dir: packDir,
			filepath: `${packName}.pack`,
		});
	});
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
				if (!isSafeFullRefName(refName)) {
					return { refName, ok: false, reason: "invalid ref name" };
				}

				const currentOid = await git
					.resolveRef({ ...repo, ref: refName })
					.catch(() => ZERO_OID);

				if (currentOid !== oldOid) {
					return {
						refName,
						ok: false,
						reason: "non-fast-forward, ref updated by another push",
					};
				}

				if (newOid === ZERO_OID) {
					await git.deleteRef({ ...repo, ref: refName }).catch(() => {});
				} else {
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

/** The report-status response body for a set of ref-update results. */
export function receivePackResponse(results: RefUpdateResult[]): GitHttpResult {
	const responseBody = concat(
		pktLine("unpack ok\n"),
		...results.map(({ refName, ok, reason }) =>
			pktLine(ok ? `ok ${refName}\n` : `ng ${refName} ${reason}\n`),
		),
		FLUSH,
	);

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
	defaultBranch?: string;
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
export async function applyReceivePack(
	repo: Repo,
	parsed: { refUpdates: RefUpdateCommand[]; packData: Uint8Array },
	options?: ApplyReceivePackOptions,
	hooks?: HttpHooks,
): Promise<{ results: RefUpdateResult[]; stalePackPaths: string[] }> {
	await ensureRepoInitialized(repo, options?.defaultBranch ?? "main");
	await indexIncomingPack(repo, parsed.packData, hooks);
	const results = await applyRefUpdates(repo, parsed.refUpdates, hooks);
	const repackOptions = options?.repack;
	const stalePackPaths =
		repackOptions === false
			? []
			: await runStep(hooks, "repack", () =>
					repackRepository(repo, repackOptions, hooks),
				);
	return { results, stalePackPaths };
}
