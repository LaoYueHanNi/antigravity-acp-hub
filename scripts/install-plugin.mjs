import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    mode: process.platform === "win32" ? "junction" : "symlink",
    target: null,
    dryRun: false,
    skipCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      opts.mode = argv[++i];
    } else if (arg === "--target" && argv[i + 1]) {
      opts.target = resolve(argv[++i]);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--skip-check") {
      opts.skipCheck = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: node scripts/install-plugin.mjs [options]
Options:
  --mode <junction|symlink|copy>  Installation mode (default: junction on Windows, symlink on Unix)
  --target <dir>                  Target plugin directory (default: ~/.gemini/config/plugins/<manifest.name>)
  --dry-run                       Validate only without writing to target
  --skip-check                    Skip node --check syntax validation`);
      process.exit(0);
    }
  }
  return opts;
}

function validatePlugin() {
  const pluginJsonPath = join(repoRoot, "plugin.json");
  const mcpConfigPath = join(repoRoot, "mcp_config.json");
  const skillPath = join(repoRoot, "skills", "acp-hub", "SKILL.md");
  const bundlePath = join(repoRoot, "dist", "mcp-server.mjs");

  for (const reqFile of [pluginJsonPath, mcpConfigPath, skillPath]) {
    if (!existsSync(reqFile)) {
      throw new Error(`Missing required plugin file: ${reqFile}`);
    }
  }

  const manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (!manifest.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
    throw new Error(`Invalid plugin.json name: "${manifest.name}" (must be lowercase kebab-case)`);
  }
  if (/^(antigravity|gemini|claude|cursor)(-|$)/i.test(manifest.name)) {
    throw new Error(
      `Invalid plugin.json name: "${manifest.name}" (must not lead with antigravity/gemini/claude/cursor)`,
    );
  }
  if (manifest.logo) {
    const logoPath = join(repoRoot, manifest.logo);
    if (!existsSync(logoPath)) {
      throw new Error(`Missing logo declared in plugin.json: ${manifest.logo}`);
    }
  }

  const mcpCfg = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  if (!mcpCfg.mcpServers || Object.keys(mcpCfg.mcpServers).length === 0) {
    throw new Error("mcp_config.json must declare at least one entry in mcpServers");
  }
  for (const [serverKey, cfg] of Object.entries(mcpCfg.mcpServers)) {
    const args = cfg.args ?? [];
    if (args.some((a) => typeof a === "string" && a.includes("dist/mcp-server.mjs"))) {
      if (!args.some((a) => typeof a === "string" && a.includes("${PLUGIN_ROOT}"))) {
        throw new Error(
          `mcp_config.json server "${serverKey}" should reference dist/mcp-server.mjs via \${PLUGIN_ROOT}`,
        );
      }
      if (!existsSync(bundlePath)) {
        throw new Error(
          `Missing self-contained bundle ${bundlePath}. Run "cd server && npm run build" first.`,
        );
      }
    }
  }

  return manifest;
}

const opts = parseArgs(process.argv.slice(2));
const manifest = validatePlugin();
const targetDir = opts.target ?? join(homedir(), ".gemini", "config", "plugins", manifest.name);

if (!opts.skipCheck) {
  const filesToCheck = [
    join(repoRoot, "dist", "mcp-server.mjs"),
    join(repoRoot, "server", "index.mjs"),
    join(repoRoot, "server", "acp-hub.mjs"),
    join(repoRoot, "server", "acp-connection.mjs"),
    join(repoRoot, "server", "harness-registry.mjs"),
    join(repoRoot, "server", "permission-policy.mjs"),
    join(repoRoot, "server", "client-capabilities.mjs"),
  ];
  for (const file of filesToCheck) {
    if (existsSync(file)) {
      execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
    }
  }
}

console.log(`[OK] Validated plugin "${manifest.name}" (${manifest.displayName}) v${manifest.version}`);
console.log(`Source: ${repoRoot}`);
console.log(`Target: ${targetDir}`);
console.log(`Mode:   ${opts.mode}`);

if (opts.dryRun) {
  console.log("[DRY RUN] Validation succeeded; no files written.");
  process.exit(0);
}

mkdirSync(dirname(targetDir), { recursive: true });
if (existsSync(targetDir)) {
  const st = lstatSync(targetDir);
  if (st.isSymbolicLink()) {
    rmSync(targetDir, { force: true });
  } else {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

if (opts.mode === "copy") {
  cpSync(repoRoot, targetDir, {
    recursive: true,
    filter: (src) => {
      const normalized = src.replace(/\\/g, "/");
      return (
        !normalized.endsWith("/.git") &&
        !normalized.includes("/.git/") &&
        !normalized.endsWith("/node_modules") &&
        !normalized.includes("/node_modules/")
      );
    },
  });
} else if (opts.mode === "junction") {
  symlinkSync(repoRoot, targetDir, "junction");
} else if (opts.mode === "symlink") {
  symlinkSync(repoRoot, targetDir, "dir");
} else {
  throw new Error(`Unsupported install mode: ${opts.mode}`);
}

console.log(`[OK] Installed plugin "${manifest.name}" to ${targetDir}`);
