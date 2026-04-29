// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { defineConfig } from "tsdown";

const shared = {
  format: ["esm"] as const,
  target: "node20" as const,
  inlineOnly: false as const,
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    ...shared,
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/cli.ts"],
    outDir: "dist",
    ...shared,
    clean: false,
    sourcemap: false,
  },
]);
