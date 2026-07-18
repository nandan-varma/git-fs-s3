import git from "isomorphic-git";
import { concat } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import { parsePktLines, pktLine, sideBandPackfile } from "./pkt-line.js";
import { collectReachableOids } from "./reachability.js";
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
export async function handleUploadPack(
	repo: Repo,
	body: Uint8Array,
	options?: UploadPackOptions,
	hooks?: HttpHooks,
): Promise<GitHttpResult> {
	const lines = parsePktLines(body);

	const wants: string[] = [];
	const haves: string[] = [];
	let done = false;
	for (const line of lines) {
		if (!line) continue;
		if (line.startsWith("want ")) {
			wants.push(line.slice(5, 45));
		}
		if (line.startsWith("have ")) {
			const sha = line.slice(5, 45);
			if (sha !== ZERO_OID) {
				haves.push(sha);
			}
		}
		if (line.startsWith("done")) {
			done = true;
		}
	}

	if (wants.length === 0) {
		return {
			status: 200,
			headers: { "Content-Type": "application/x-git-upload-pack-result" },
			body: concat(pktLine("NAK\n")),
		};
	}

	if (haves.length > 0 && !done) {
		return {
			status: 200,
			headers: { "Content-Type": "application/x-git-upload-pack-result" },
			body: concat(pktLine("NAK\n")),
		};
	}

	// Fresh clone = no haves, so all objects are needed. When the repo is down
	// to a single pack, serve it directly and skip the traversal + pack build.
	if (haves.length === 0) {
		const packDirPath = `${repo.gitdir}/objects/pack`;
		const entries = await runStep(hooks, "readdir objects/pack", () =>
			rawFs(repo)
				.readdir(packDirPath)
				.catch(() => [] as string[]),
		);
		const packNames = entries.filter((f) => f.endsWith(".pack"));
		const packName = packNames[0];
		if (packNames.length === 1 && packName !== undefined) {
			const packData = await runStep(
				hooks,
				"read consolidated pack (fast path)",
				() => rawFs(repo).readFile(`${packDirPath}/${packName}`),
			);
			const bytes =
				packData instanceof Uint8Array
					? packData
					: new TextEncoder().encode(packData as string);
			return {
				status: 200,
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
					"Cache-Control": "no-cache",
				},
				body: concat(pktLine("NAK\n"), sideBandPackfile(bytes)),
			};
		}
	}

	if (options?.beforeWalk) {
		await runStep(hooks, "beforeWalk", options.beforeWalk);
	}

	const { oids: wantOids } = await runStep(
		hooks,
		"collectReachableOids(wants)",
		() => collectReachableOids(repo, wants, hooks),
	);
	let oids = wantOids;

	if (haves.length > 0) {
		const { oids: haveOids } = await runStep(
			hooks,
			"collectReachableOids(haves)",
			() => collectReachableOids(repo, haves, hooks),
		);
		const haveSet = new Set(haveOids);
		oids = oids.filter((oid) => !haveSet.has(oid));
	}

	const { packfile } = await runStep(
		hooks,
		`packObjects (${oids.length} oids)`,
		() => git.packObjects({ ...repo, oids }),
	);

	const packBytes =
		packfile instanceof Uint8Array ? packfile : new Uint8Array(packfile ?? []);

	return {
		status: 200,
		headers: {
			"Content-Type": "application/x-git-upload-pack-result",
			"Cache-Control": "no-cache",
		},
		body: concat(pktLine("NAK\n"), sideBandPackfile(packBytes)),
	};
}
