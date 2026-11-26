import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    mode: "copy",
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
  --mode <copy|symlink|junction>  Installation mode (default: copy; recommended on Windows since Antigravity skips junctions)
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
    join(repoRoot, "server", "task-manager.mjs"),
    join(repoRoot, "server", "dashboard-resource.mjs"),
    join(repoRoot, "server", "task-pane-resource.mjs"),
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

function copyPluginTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyPluginTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

mkdirSync(dirname(targetDir), { recursive: true });
let inPlaceUpdate = false;
if (existsSync(targetDir)) {
  const st = lstatSync(targetDir);
  if (st.isSymbolicLink()) {
    // On Windows, directory junctions report isSymbolicLink()=true and require rmdirSync to unlink safely.
    try {
      rmSync(targetDir, { force: true });
    } catch {
      rmdirSync(targetDir);
    }
  } else if (opts.mode === "copy") {
    inPlaceUpdate = true;
  } else {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

if (opts.mode === "copy") {
  copyPluginTree(repoRoot, targetDir);
  if (inPlaceUpdate) {
    console.log(
      "[INFO] Updated existing plugin files in place. Restart acp-hub_bridge in Antigravity MCP Servers settings to load the new bundle.",
    );
  }
} else if (opts.mode === "junction") {
  symlinkSync(repoRoot, targetDir, "junction");
} else if (opts.mode === "symlink") {
  symlinkSync(repoRoot, targetDir, "dir");
} else {
  throw new Error(`Unsupported install mode: ${opts.mode}`);
}

console.log(`[OK] Installed plugin "${manifest.name}" to ${targetDir}`);
