import { GitPathNotFoundError } from "../git-errors.js";
import { getFileContent } from "./history.js";
import type { OpsHooks, Repo } from "./types.js";

export interface SubmoduleConfig {
	name: string;
	path: string;
	url: string;
}

/** Git config values: comments outside quotes, quoted whitespace, and Git's escapes. */
function parseValue(raw: string): string | null {
	let value = "";
	let spaces = "";
	let quoted = false;
	const escapes: Record<string, string> = {
		n: "\n",
		t: "\t",
		b: "\b",
		"\\": "\\",
		'"': '"',
	};
	for (let i = 0; i < raw.length; i++) {
		const c = raw.charAt(i);
		if (c === "\\") {
			const escaped = escapes[raw.charAt(++i)];
			if (escaped === undefined) return null;
			value += spaces + escaped;
			spaces = "";
		} else if (c === '"') {
			value += spaces;
			spaces = "";
			quoted = !quoted;
		} else if (!quoted && (c === "#" || c === ";")) break;
		else if (!quoted && /\s/.test(c)) {
			if (value) spaces += c;
		} else {
			value += spaces + c;
			spaces = "";
		}
	}
	return quoted ? null : value;
}

/**
 * Read only submodule path/url records. Never expands includes, executes Git
 * commands, or fetches URLs. Ambiguous paths and malformed records are ignored.
 */
export function parseGitmodules(content: string): SubmoduleConfig[] {
	const sections = new Map<string, Partial<SubmoduleConfig>>();
	let current: Partial<SubmoduleConfig> | undefined;
	const lines: string[] = [];
	let pending = "";
	for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
		const slashes = /\\+$/.exec(line)?.[0].length ?? 0;
		if (slashes % 2 === 1) pending += line.slice(0, -1);
		else {
			lines.push(pending + line);
			pending = "";
		}
	}
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || /^[#;]/.test(trimmed)) continue;
		if (trimmed.startsWith("[")) {
			const match =
				/^\[submodule\s+"((?:[^"\\]|\\["\\])*)"\]\s*(?:[#;].*)?$/i.exec(
					trimmed,
				);
			current = undefined;
			if (!match?.[1]) continue;
			const name = match[1].replace(/\\(["\\])/g, "$1");
			current = sections.get(name) ?? { name };
			sections.set(name, current);
			continue;
		}
		if (!current) continue;
		const field = /^(path|url)\s*=\s*(.*)$/i.exec(trimmed);
		if (!field?.[1] || field[2] === undefined) continue;
		const key = field[1].toLowerCase() as "path" | "url";
		const value = parseValue(field[2]);
		if (value === null) delete current[key];
		else current[key] = value;
	}
	const valid = [...sections.values()].filter(
		(s): s is SubmoduleConfig =>
			!!s.name &&
			!!s.path &&
			!!s.url &&
			![...(s.path + s.url)].some(
				(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
			) &&
			!s.path.startsWith("/") &&
			!s.path.includes("\\") &&
			s.path
				.split("/")
				.every(
					(p) =>
						p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git",
				),
	);
	const counts = new Map<string, number>();
	for (const s of valid) counts.set(s.path, (counts.get(s.path) ?? 0) + 1);
	return valid.filter((s) => counts.get(s.path) === 1);
}

/** The root .gitmodules at this exact revision; absent/oversized config yields no links. */
export async function getSubmodules(
	repo: Repo,
	ref: string,
	hooks?: OpsHooks,
): Promise<SubmoduleConfig[]> {
	let bytes: Uint8Array;
	try {
		bytes = await getFileContent(repo, ".gitmodules", ref, hooks);
	} catch (error) {
		if (error instanceof GitPathNotFoundError) return [];
		throw error;
	}
	if (bytes.length > 1024 * 1024) return [];
	return parseGitmodules(new TextDecoder().decode(bytes));
}
