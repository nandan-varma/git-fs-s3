import { describe, expect, it } from "vitest";
import {
	packFileName,
	parsePackDirectory,
	parsePackFileName,
} from "../src/pack-files.js";

describe("pack-files", () => {
	it("parses every kind git writes into objects/pack", () => {
		expect(parsePackFileName("pack-abc.idx")).toEqual({
			base: "pack-abc",
			kind: "idx",
			name: "pack-abc.idx",
		});
		expect(parsePackFileName("pack-abc.bitmap")?.kind).toBe("bitmap");
	});

	it("rejects names that aren't pack files", () => {
		expect(parsePackFileName("pack-abc.tmp")).toBeNull();
		expect(parsePackFileName(".pack")).toBeNull();
		expect(parsePackFileName("README")).toBeNull();
	});

	it("parses a listing and builds sibling names", () => {
		const files = parsePackDirectory(["a.pack", "a.idx", "junk", "b.rev"]);
		expect(files.map((f) => f.name)).toEqual(["a.pack", "a.idx", "b.rev"]);
		expect(packFileName("a", "idx")).toBe("a.idx");
	});
});
