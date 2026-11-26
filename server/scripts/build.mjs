import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..");
const repoRoot = resolve(serverDir, "..");
const entryPoint = resolve(serverDir, "index.mjs");
const outfile = resolve(repoRoot, "dist", "mcp-server.mjs");

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  banner: {
    js: [
      'import { createRequire as __acpHubCreateRequire } from "node:module";',
      "const require = __acpHubCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

const sizeKb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`[build] Generated self-contained MCP bundle: ${outfile} (${sizeKb} KB)`);
