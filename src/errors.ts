/**
 * Node-style filesystem error carrying a `code` property, which is what
 * isomorphic-git inspects to distinguish "file not found" from real failures.
 */
export class FsError extends Error {
	readonly code: string;
	readonly syscall: string;
	readonly path: string;

	constructor(code: string, syscall: string, path: string) {
		super(`${code}: ${syscall} '${path}'`);
		this.name = "FsError";
		this.code = code;
		this.syscall = syscall;
		this.path = path;
	}
}

export const enoent = (syscall: string, path: string) =>
	new FsError("ENOENT", syscall, path);

export const enotdir = (syscall: string, path: string) =>
	new FsError("ENOTDIR", syscall, path);

export const eisdir = (syscall: string, path: string) =>
	new FsError("EISDIR", syscall, path);

export const enotempty = (syscall: string, path: string) =>
	new FsError("ENOTEMPTY", syscall, path);

export const einval = (syscall: string, path: string) =>
	new FsError("EINVAL", syscall, path);

export const eperm = (syscall: string, path: string) =>
	new FsError("EPERM", syscall, path);
