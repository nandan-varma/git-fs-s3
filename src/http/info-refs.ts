import git from "isomorphic-git";
import { concat } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import { FLUSH, pktLine } from "./pkt-line.js";
import { type GitHttpResult, type HttpHooks, runStep } from "./types.js";

export type GitService = "git-upload-pack" | "git-receive-pack";

/** All refs with resolved oids, plus the symref HEAD should advertise. */
export async function listAllRefs(repo: Repo, defaultBranch = "main") {
	// Fetch branch/tag lists and HEAD in parallel
	const [branches, tags, headOid, headSymref] = await Promise.all([
		git.listBranches(repo),
		git.listTags(repo),
		git.resolveRef({ ...repo, ref: "HEAD" }).catch(() => null),
		// Wrap with Promise.resolve so a mock/stub returning undefined doesn't crash .then()
		Promise.resolve(git.currentBranch({ ...repo, fullname: true }))
			.then((cb) => cb ?? `refs/heads/${defaultBranch}`)
			.catch(() => `refs/heads/${defaultBranch}`),
	]);

	// Resolve all branch and tag oids in parallel
	const [branchRefs, tagRefs] = await Promise.all([
		Promise.all(
			branches.map(async (branch) => {
				try {
					const oid = await git.resolveRef({
						...repo,
						ref: `refs/heads/${branch}`,
					});
					return { name: `refs/heads/${branch}`, oid };
				} catch {
					return null;
				}
			}),
		),
		Promise.all(
			tags.map(async (tag) => {
				try {
					const oid = await git.resolveRef({
						...repo,
						ref: `refs/tags/${tag}`,
					});
					return { name: `refs/tags/${tag}`, oid };
				} catch {
					return null;
				}
			}),
		),
	]);

	const refs: Array<{ name: string; oid: string }> = [];
	if (headOid) refs.push({ name: "HEAD", oid: headOid });
	for (const r of branchRefs) if (r) refs.push(r);
	for (const r of tagRefs) if (r) refs.push(r);

	return { refs, headSymref };
}

export interface InfoRefsOptions {
	service: GitService;
	defaultBranch?: string;
	/** Advertised in the agent capability. Default "git-fs-s3". */
	agent?: string;
}

/**
 * `GET …/info/refs?service=…` — the ref advertisement. Authentication and
 * authorization are the caller's job before invoking this.
 *
 * Capabilities advertised match what the sibling handlers implement:
 * side-band-64k (honored by handleUploadPack's response framing — clients
 * like isomorphic-git unconditionally expect it), tip/reachable sha1 wants,
 * delete-refs and report-status for pushes.
 */
export async function handleInfoRefs(
	repo: Repo,
	options: InfoRefsOptions,
	hooks?: HttpHooks,
): Promise<GitHttpResult> {
	const { service } = options;
	const agent = options.agent ?? "git-fs-s3";
	const { refs, headSymref } = await runStep(hooks, "listAllRefs", () =>
		listAllRefs(repo, options.defaultBranch ?? "main"),
	);

	const isUpload = service === "git-upload-pack";
	const caps = isUpload
		? `no-progress side-band-64k symref=HEAD:${headSymref} allow-tip-sha1-in-want allow-reachable-sha1-in-want agent=${agent}`
		: `delete-refs report-status no-done agent=${agent}`;

	const parts: Uint8Array[] = [pktLine(`# service=${service}\n`), FLUSH];

	if (refs.length === 0) {
		// Empty repo: git needs this exact sentinel
		parts.push(
			pktLine(
				`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`,
			),
		);
	} else {
		let first = true;
		for (const { name, oid } of refs) {
			parts.push(
				pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`),
			);
			first = false;
		}
	}
	parts.push(FLUSH);

	return {
		status: 200,
		headers: {
			"Content-Type": `application/x-${service}-advertisement`,
			"Cache-Control": "no-cache",
		},
		body: concat(...parts),
	};
}
