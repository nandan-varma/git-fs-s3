import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		s3: "src/stores/s3.ts",
		"fetch-s3": "src/stores/fetch-s3.ts",
		node: "src/stores/file.ts",
		ops: "src/ops/index.ts",
		http: "src/http/index.ts",
	},
	format: ["esm"],
	// Declarations come from `tsc -p tsconfig.build.json` (see the build script).
	dts: false,
	sourcemap: true,
	clean: true,
	target: "node22",
	external: ["@aws-sdk/client-s3", "aws4fetch", "isomorphic-git", "diff"],
});
