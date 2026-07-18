import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		s3: "src/stores/s3.ts",
		ops: "src/ops/index.ts",
		http: "src/http/index.ts",
	},
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node18",
	external: ["@aws-sdk/client-s3", "isomorphic-git", "diff"],
});
