import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileObjectStore } from "../src/stores/file.js";

const bytes = (text: string) => new TextEncoder().encode(text);
let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "git-fs-s3-file-store-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("FileObjectStore", () => {
	it("keeps writes and deletes across instances", async () => {
		const first = new FileObjectStore(root);
		await first.put(
			"repos/alice/demo/git/HEAD",
			bytes("ref: refs/heads/main\n"),
		);
		await first.put("repos/alice/demo/git/objects/pack/a.pack", bytes("PACK"));
		await first.put("repos/alice/demo/git/gone", bytes("x"));
		await first.delete("repos/alice/demo/git/gone");

		const second = new FileObjectStore(root);
		expect(await second.get("repos/alice/demo/git/HEAD")).toEqual(
			bytes("ref: refs/heads/main\n"),
		);
		expect(
			await second.getRange("repos/alice/demo/git/objects/pack/a.pack", 1, 3),
		).toEqual(bytes("ACK"));
		expect(await second.head("repos/alice/demo/git/gone")).toBeNull();
		const listed = await second.list("repos/alice/demo/git/", {
			delimiter: "/",
		});
		expect(listed.objects.map((o) => o.key)).toEqual([
			"repos/alice/demo/git/HEAD",
		]);
		expect(listed.prefixes).toEqual(["repos/alice/demo/git/objects/"]);
	});

	it("refuses keys that would leave the store's directory", async () => {
		const store = new FileObjectStore(root);
		await expect(store.put("../escape", bytes("x"))).rejects.toThrow(
			"escapes the store root",
		);
	});
});
