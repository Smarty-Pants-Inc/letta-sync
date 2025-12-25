#!/usr/bin/env bun

/**
 * Build script for Letta Sync CLI
 * Bundles TypeScript source into a single JavaScript file
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const version = pkg.version;

console.log(`Building letta-sync v${version}...`);

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  minify: false, // Keep readable for debugging
  sourcemap: "external",
  naming: {
    entry: "letta-sync.js",
  },
  define: {
    "process.env.LETTA_SYNC_VERSION": JSON.stringify(version),
  },
});

if (!result.success) {
  console.error("❌ Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Add shebang to output file
const outputPath = join(__dirname, "letta-sync.js");
let content = readFileSync(outputPath, "utf-8");

// Remove any existing shebang first
if (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}

const withShebang = `#!/usr/bin/env node\n${content}`;
await Bun.write(outputPath, withShebang);

// Make executable
await Bun.$`chmod +x letta-sync.js`;

console.log("Build complete.");
console.log("Output: letta-sync.js");
console.log(
  `Size: ${((await Bun.file(outputPath).size) / 1024).toFixed(0)}KB`,
);
