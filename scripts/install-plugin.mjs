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
    target: join(homedir(), ".gemini", "config", "plugins", "antigravity-acp-hub"),
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
  --target <dir>                  Target plugin directory (default: ~/.gemini/config/plugins/antigravity-acp-hub)
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
  const serverNodeModules = join(repoRoot, "server", "node_modules");

  for (const reqFile of [pluginJsonPath, mcpConfigPath, skillPath]) {
    if (!existsSync(reqFile)) {
      throw new Error(`Missing required plugin file: ${reqFile}`);
    }
  }

  const manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) {
    throw new Error(`Invalid plugin.json name: "${manifest.name}" (must be lowercase kebab-case)`);
  }

  const mcpCfg = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  if (!mcpCfg.mcpServers || Object.keys(mcpCfg.mcpServers).length === 0) {
    throw new Error("mcp_config.json must declare at least one entry in mcpServers");
  }

  if (!existsSync(serverNodeModules)) {
    throw new Error(
      `Missing ${serverNodeModules}. Run "cd server && npm install" before installing the plugin.`,
    );
  }

  return manifest;
}

const opts = parseArgs(process.argv.slice(2));
const manifest = validatePlugin();

if (!opts.skipCheck) {
  const serverFiles = [
    "index.mjs",
    "acp-hub.mjs",
    "acp-connection.mjs",
    "harness-registry.mjs",
    "permission-policy.mjs",
    "client-capabilities.mjs",
  ];
  for (const file of serverFiles) {
    execFileSync(process.execPath, ["--check", join(repoRoot, "server", file)], {
      stdio: "inherit",
    });
  }
}

console.log(`[OK] Validated plugin "${manifest.name}" v${manifest.version}`);
console.log(`Source: ${repoRoot}`);
console.log(`Target: ${opts.target}`);
console.log(`Mode:   ${opts.mode}`);

if (opts.dryRun) {
  console.log("[DRY RUN] Validation succeeded; no files written.");
  process.exit(0);
}

mkdirSync(dirname(opts.target), { recursive: true });
if (existsSync(opts.target)) {
  const st = lstatSync(opts.target);
  if (st.isSymbolicLink()) {
    rmSync(opts.target, { force: true });
  } else {
    rmSync(opts.target, { recursive: true, force: true });
  }
}

if (opts.mode === "copy") {
  cpSync(repoRoot, opts.target, {
    recursive: true,
    filter: (src) => {
      const normalized = src.replace(/\\/g, "/");
      return !normalized.endsWith("/.git") && !normalized.includes("/.git/");
    },
  });
} else if (opts.mode === "junction") {
  symlinkSync(repoRoot, opts.target, "junction");
} else if (opts.mode === "symlink") {
  symlinkSync(repoRoot, opts.target, "dir");
} else {
  throw new Error(`Unsupported install mode: ${opts.mode}`);
}

console.log(`[OK] Installed plugin "${manifest.name}" to ${opts.target}`);
