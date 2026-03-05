import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      middy: "src/middy.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    target: "node20",
    sourcemap: true,
  },
]);
