import git from "isomorphic-git";
import { concat } from "../edge-utils.js";
import {
	listBranches,
	listLooseRefNames,
	resolveLooseRefFast,
} from "../ops/branch.js";
import type { Repo } from "../ops/types.js";
import { FLUSH, pktLine } from "./pkt-line.js";
import { type GitHttpResult, type HttpHooks, runStep } from "./types.js";

export type GitService = "git-upload-pack" | "git-receive-pack";

/** All refs with resolved oids, plus the symref HEAD should advertise. */
export async function listAllRefs(repo: Repo, defaultBranch: string) {
	const [branches, tagNames] = await Promise.all([
		listBranches(repo),
		listLooseRefNames(repo, "refs/tags").then(
			(names) => names ?? git.listTags(repo),
		),
	]);
	const tagRefs = await Promise.all(
		tagNames.map(async (tag) => {
			const name = `refs/tags/${tag}`;
			return resolveLooseRefFast(repo, name)
				.then((oid) => ({ name, oid }))
				.catch(() => null);
		}),
	);
	const branchRefs = branches.map((b) => ({
		name: `refs/heads/${b.name}`,
		oid: b.commit,
	}));
	// HEAD is almost always a symref to a listed branch: reuse that branch's
	// oid. Only a detached HEAD needs resolving; an unborn branch (empty repo)
	// has none — resolving it would just miss every candidate ref path.
	const defaultRef = branches.find((b) => b.isDefault);
	const current = defaultRef
		? null
		: await git
				.currentBranch({ ...repo, fullname: true })
				.catch(() => undefined);
	const headSymref = defaultRef
		? `refs/heads/${defaultRef.name}`
		: (current ?? `refs/heads/${defaultBranch}`);
	const headOid =
		branchRefs.find((r) => r.name === headSymref)?.oid ??
		(defaultRef || current
			? null
			: await git.resolveRef({ ...repo, ref: "HEAD" }).catch(() => null));

	const refs: Array<{ name: string; oid: string }> = [];
	if (headOid) refs.push({ name: "HEAD", oid: headOid });
	refs.push(...branchRefs);
	for (const r of tagRefs) if (r) refs.push(r);

	return { refs, headSymref };
}

export interface InfoRefsOptions {
	service: GitService;
	/** Advertised as HEAD when HEAD itself doesn't name an existing branch. */
	defaultBranch: string;
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
		listAllRefs(repo, options.defaultBranch),
	);

	const isUpload = service === "git-upload-pack";
	const caps = isUpload
		? `no-progress side-band-64k symref=HEAD:${headSymref} allow-tip-sha1-in-want allow-reachable-sha1-in-want agent=${agent}`
		: `report-status delete-refs side-band-64k agent=${agent}`;

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
