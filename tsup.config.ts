import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		s3: "src/stores/s3.ts",
	},
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node18",
	external: ["@aws-sdk/client-s3"],
});
