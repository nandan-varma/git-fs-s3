/**
 * Git-server error types carrying an HTTP status and a retryability flag, so
 * transport layers can map internal failures to responses without inspecting
 * messages. Extend {@link GitError} for app-specific cases (storage backends,
 * quota, …) and {@link formatErrorResponse} keeps working for them.
 */
export class GitError extends Error {
	statusCode: number;
	retryable: boolean;

	constructor(message: string, statusCode = 500, retryable = false) {
		super(message);
		this.name = this.constructor.name;
		this.statusCode = statusCode;
		this.retryable = retryable;
		Error.captureStackTrace?.(this, this.constructor);
	}

	toJSON(): Record<string, unknown> {
		return {
			error: this.name,
			message: this.message,
			statusCode: this.statusCode,
			retryable: this.retryable,
		};
	}
}

/** A file/directory path not found within a tree (404). */
export class GitPathNotFoundError extends GitError {
	constructor(message: string) {
		super(message, 404, false);
	}
}

/** A git object not found (404). */
export class GitObjectNotFoundError extends GitError {
	constructor(message: string) {
		super(message, 404, false);
	}
}

/** A ref (branch/tag) not found (404). */
export class GitRefNotFoundError extends GitError {
	constructor(message: string) {
		super(message, 404, false);
	}
}

/** The repository itself not found (404). */
export class GitRepositoryNotFoundError extends GitError {
	constructor(message: string) {
		super(message, 404, false);
	}
}

export interface MergeConflictDetail {
	file: string;
	baseLines?: string[];
	sourceLines?: string[];
	targetLines?: string[];
}

/** A merge conflict (409), carrying per-file conflict detail. */
export class GitConflictError extends GitError {
	conflicts: MergeConflictDetail[];

	constructor(message: string, conflicts: MergeConflictDetail[] = []) {
		super(message, 409, false);
		this.conflicts = conflicts;
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), conflicts: this.conflicts };
	}
}

/** Authentication failed (401). */
export class GitAuthenticationError extends GitError {
	constructor(message: string) {
		super(message, 401, false);
	}
}

/** Authorization failed (403). */
export class GitAuthorizationError extends GitError {
	constructor(message: string) {
		super(message, 403, false);
	}
}

/** Too many failed attempts (429). */
export class GitRateLimitError extends GitError {
	constructor(message: string) {
		super(message, 429, false);
	}
}

/** Malformed request (400). */
export class GitInvalidRequestError extends GitError {
	constructor(message: string) {
		super(message, 400, false);
	}
}

/** Git wire-protocol violation (400). */
export class GitProtocolError extends GitError {
	constructor(message: string) {
		super(message, 400, false);
	}
}

/**
 * Map any error to an HTTP response shape. 401s carry the WWW-Authenticate
 * header git clients need before they will prompt for credentials. Non-GitError
 * failures are masked as opaque 500s — internal messages don't leak.
 */
export function formatErrorResponse(error: unknown): {
	status: number;
	body: Record<string, unknown>;
	headers?: Record<string, string>;
} {
	if (error instanceof GitError) {
		return {
			status: error.statusCode,
			body: error.toJSON(),
			headers:
				error.statusCode === 401
					? { "WWW-Authenticate": 'Basic realm="Git Repository"' }
					: undefined,
		};
	}

	if (error instanceof Error) {
		return {
			status: 500,
			body: {
				error: "InternalServerError",
				message: "An internal error occurred",
				retryable: true,
			},
		};
	}

	return {
		status: 500,
		body: {
			error: "UnknownError",
			message: "An unknown error occurred",
			retryable: true,
		},
	};
}
