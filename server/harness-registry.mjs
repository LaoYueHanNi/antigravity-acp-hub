import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = join(homedir(), ".gemini", "config", "acp-harnesses.json");

const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({
  fs: false,
  terminal: false,
});

/**
 * Built-in vendor-neutral presets.
 * Core server keeps zero heavy vendor SDK dependencies; presets auto-discover
 * locally installed ACP binaries/adapters (or optional user-installed packages)
 * without hardcoding any machine-specific paths.
 */
export const BUILTIN_HARNESS_PRESETS = Object.freeze({
  claude: {
    displayName: "Claude Code",
    description: "Anthropic Claude Code via ACP adapter (claude-agent-acp / claude-code-acp).",
    enabled: true,
    resolvers: [
      { type: "command", command: "claude-agent-acp", args: [] },
      {
        type: "local_pkg",
        pkg: "@agentclientprotocol/claude-agent-acp",
        entry: "dist/index.js",
        args: [],
      },
      { type: "command", command: "claude-code-acp", args: [] },
    ],
    npxFallback: { pkg: "@agentclientprotocol/claude-agent-acp", args: [] },
    installHint: "npm i -g @agentclientprotocol/claude-agent-acp",
    defaultMode: "default",
    defaultApprovalPolicy: "read_only",
    allowNpxFallback: false,
    clientCapabilities: { fs: false, terminal: false },
    timeoutSeconds: 300,
    env: {},
  },
  codex: {
    displayName: "Codex CLI",
    description: "OpenAI Codex CLI via official ACP adapter (@agentclientprotocol/codex-acp).",
    enabled: true,
    resolvers: [
      { type: "command", command: "codex-acp", args: [] },
      {
        type: "local_pkg",
        pkg: "@agentclientprotocol/codex-acp",
        entry: "dist/index.js",
        args: [],
      },
    ],
    npxFallback: { pkg: "@agentclientprotocol/codex-acp", args: [] },
    installHint: "npm i -g @agentclientprotocol/codex-acp",
    defaultApprovalPolicy: "read_only",
    allowNpxFallback: false,
    clientCapabilities: { fs: false, terminal: false },
    timeoutSeconds: 300,
    env: {},
  },
  gemini: {
    displayName: "Gemini CLI",
    description: "Google Gemini CLI native ACP mode (gemini --acp).",
    enabled: true,
    resolvers: [{ type: "command", command: "gemini", args: ["--acp"] }],
    installHint: "npm i -g @google/gemini-cli",
    defaultApprovalPolicy: "read_only",
    allowNpxFallback: false,
    clientCapabilities: { fs: false, terminal: false },
    timeoutSeconds: 300,
    env: {},
  },
  opencode: {
    displayName: "OpenCode",
    description: "OpenCode native ACP mode (opencode acp).",
    enabled: true,
    resolvers: [{ type: "command", command: "opencode", args: ["acp"] }],
    installHint: "Install OpenCode CLI from https://opencode.ai",
    defaultApprovalPolicy: "read_only",
    allowNpxFallback: false,
    clientCapabilities: { fs: false, terminal: false },
    timeoutSeconds: 300,
    env: {},
  },
  goose: {
    displayName: "Goose",
    description: "Block Goose native ACP mode (goose acp).",
    enabled: true,
    resolvers: [{ type: "command", command: "goose", args: ["acp"] }],
    installHint: "Install Goose CLI from https://block.github.io/goose",
    defaultApprovalPolicy: "read_only",
    allowNpxFallback: false,
    clientCapabilities: { fs: false, terminal: false },
    timeoutSeconds: 300,
    env: {},
  },
});

function isFileExisting(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Search PATH (or resolve direct path) for an executable command.
 * On Windows, prefers .exe / .cmd / .bat over .ps1 so child_process.spawn works reliably.
 */
export function findExecutableInPath(command, env = process.env) {
  if (!command || typeof command !== "string") return null;

  const isWin = process.platform === "win32";
  const winExts = [".exe", ".cmd", ".bat", ".com"];
  const hasPathSep = command.includes("/") || command.includes("\\");

  const checkCandidate = (basePath) => {
    if (isWin) {
      const lowerExt = extname(basePath).toLowerCase();
      if (lowerExt) {
        return isFileExisting(basePath) ? basePath : null;
      }
      for (const ext of winExts) {
        const full = `${basePath}${ext}`;
        if (isFileExisting(full)) return full;
      }
      return isFileExisting(basePath) ? basePath : null;
    }
    return isFileExisting(basePath) ? basePath : null;
  };

  if (isAbsolute(command) || hasPathSep) {
    return checkCandidate(resolve(command));
  }

  const pathEnv = env.PATH || env.Path || "";
  for (const rawDir of pathEnv.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const hit = checkCandidate(join(dir, command));
    if (hit) return hit;
  }

  return null;
}

/**
 * On Windows, npm global shims (.cmd) typically invoke node on a script under
 * %~dp0\node_modules\<pkg>\...\*.js. Extracting that script lets us spawn
 * node directly without cmd.exe indirection (clean PID termination, no escaping bugs).
 */
function tryExtractNodeScriptFromNpmCmd(cmdFilePath) {
  try {
    const content = readFileSync(cmdFilePath, "utf8");
    const match = content.match(/"(?:%~dp0|%dp0%)\\([^"\r\n]+\.(?:m?js|cjs))"/i);
    if (!match) return null;
    const relScript = match[1].replace(/\\/g, "/");
    const candidate = resolve(dirname(cmdFilePath), relScript);
    return isFileExisting(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Convert an executable + args into a cross-platform child_process.spawn spec.
 */
export function buildSpawnSpec(executablePath, args = []) {
  const isWin = process.platform === "win32";
  const ext = extname(executablePath).toLowerCase();

  if (isWin && (ext === ".cmd" || ext === ".bat")) {
    const nodeScript = tryExtractNodeScriptFromNpmCmd(executablePath);
    if (nodeScript) {
      return {
        command: process.execPath,
        args: [nodeScript, ...args],
      };
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", executablePath, ...args],
    };
  }

  return {
    command: executablePath,
    args: [...args],
  };
}

/**
 * Resolve local package entry inside server/node_modules (or repo root node_modules
 * when executed from dist/mcp-server.mjs) if optionally installed.
 */
function resolveLocalPackageEntry(pkgName, entryRelPath, serverDir = __dirname) {
  const pkgParts = [...pkgName.split("/"), ...entryRelPath.split("/")];
  const candidates = [
    join(serverDir, "node_modules", ...pkgParts),
    join(dirname(serverDir), "server", "node_modules", ...pkgParts),
    join(dirname(serverDir), "node_modules", ...pkgParts),
  ];
  for (const candidate of candidates) {
    if (isFileExisting(candidate)) return candidate;
  }
  return null;
}

/**
 * Substitute optional <builtin:pkg> placeholders in user-configured args.
 */
function expandArgPlaceholders(args, serverDir = __dirname) {
  return (args ?? []).map((arg) => {
    if (typeof arg !== "string") return String(arg);
    const m = arg.match(/^<builtin:([^>]+)>$/);
    if (!m) return arg;
    const pkg = m[1].trim();
    const resolved = resolveLocalPackageEntry(pkg, "dist/index.js", serverDir);
    return resolved ?? arg;
  });
}

function mergeHarnessEntry(id, preset, userOverride = {}) {
  const base = preset
    ? {
        ...preset,
        clientCapabilities: { ...DEFAULT_CLIENT_CAPABILITIES, ...(preset.clientCapabilities ?? {}) },
        env: { ...(preset.env ?? {}) },
      }
    : {
        displayName: id,
        description: "Custom ACP Harness",
        enabled: true,
        resolvers: [],
        installHint: "",
        defaultApprovalPolicy: "read_only",
        allowNpxFallback: false,
        clientCapabilities: { ...DEFAULT_CLIENT_CAPABILITIES },
        timeoutSeconds: 300,
        env: {},
      };

  const merged = {
    ...base,
    ...userOverride,
    id,
    isBuiltin: Boolean(preset),
    displayName: userOverride.displayName ?? base.displayName ?? id,
    enabled: userOverride.enabled ?? base.enabled ?? true,
    allowNpxFallback: userOverride.allowNpxFallback ?? base.allowNpxFallback ?? false,
    defaultApprovalPolicy:
      userOverride.defaultApprovalPolicy ?? base.defaultApprovalPolicy ?? "read_only",
    timeoutSeconds: userOverride.timeoutSeconds ?? base.timeoutSeconds ?? 300,
    clientCapabilities: {
      ...DEFAULT_CLIENT_CAPABILITIES,
      ...(base.clientCapabilities ?? {}),
      ...(userOverride.clientCapabilities ?? {}),
    },
    env: {
      ...(base.env ?? {}),
      ...(userOverride.env ?? {}),
    },
  };

  if (typeof userOverride.command === "string" && userOverride.command.trim()) {
    merged.command = userOverride.command.trim();
    merged.args = Array.isArray(userOverride.args) ? [...userOverride.args] : [];
  }

  return merged;
}

export class HarnessRegistry {
  constructor({ configPath, inlineConfig, serverDir = __dirname } = {}) {
    this.configPath =
      configPath !== undefined
        ? configPath
        : process.env.ACP_HUB_CONFIG || DEFAULT_CONFIG_PATH;
    this.inlineConfig = inlineConfig ?? null;
    this.serverDir = serverDir;
    this.defaultHarness = "claude";
    this.harnesses = new Map();
    this.lastConfigMtimeMs = null;
    this.configLoadWarning = null;
    this._writeQueue = Promise.resolve();
    this.reload();
  }

  reload() {
    let userConfig = null;
    this.configLoadWarning = null;

    if (this.inlineConfig) {
      userConfig = this.inlineConfig;
    } else if (this.configPath && existsSync(this.configPath)) {
      try {
        const st = statSync(this.configPath);
        this.lastConfigMtimeMs = st.mtimeMs;
        const raw = readFileSync(this.configPath, "utf8");
        userConfig = JSON.parse(raw);
      } catch (err) {
        this.configLoadWarning = `Failed to load ${this.configPath}: ${err.message}`;
      }
    } else {
      this.lastConfigMtimeMs = null;
    }

    const userHarnesses =
      userConfig && typeof userConfig.harnesses === "object" && userConfig.harnesses !== null
        ? userConfig.harnesses
        : {};

    const nextMap = new Map();

    // 1. Built-in presets (merged with any user override)
    for (const [id, preset] of Object.entries(BUILTIN_HARNESS_PRESETS)) {
      const override = userHarnesses[id] ?? {};
      nextMap.set(id, mergeHarnessEntry(id, preset, override));
    }

    // 2. Purely custom user harnesses
    for (const [id, custom] of Object.entries(userHarnesses)) {
      if (nextMap.has(id) || !custom || typeof custom !== "object") continue;
      nextMap.set(id, mergeHarnessEntry(id, null, custom));
    }

    this.harnesses = nextMap;
    this.defaultHarness =
      typeof userConfig?.defaultHarness === "string" && nextMap.has(userConfig.defaultHarness)
        ? userConfig.defaultHarness
        : "claude";
  }

  /**
   * Hot-reload user config file if modified on disk since last load.
   */
  reloadIfChanged() {
    if (this.inlineConfig || !this.configPath) return;
    if (!existsSync(this.configPath)) {
      if (this.lastConfigMtimeMs !== null) {
        this.reload();
      }
      return;
    }
    try {
      const mtime = statSync(this.configPath).mtimeMs;
      if (mtime !== this.lastConfigMtimeMs) {
        this.reload();
      }
    } catch {
      // ignore transient stat errors
    }
  }

  get(harnessId) {
    this.reloadIfChanged();
    return this.harnesses.get(harnessId) ?? null;
  }

  has(harnessId) {
    this.reloadIfChanged();
    return this.harnesses.has(harnessId);
  }

  listAll() {
    this.reloadIfChanged();
    return Array.from(this.harnesses.values());
  }

  /**
   * Atomically update user configuration file (or inlineConfig in memory),
   * serialized via an internal queue to prevent lost updates on rapid toggles.
   */
  async updateConfig(mutator) {
    const run = async () => {
      if (this.inlineConfig) {
        const draft = structuredClone(this.inlineConfig);
        if (!draft.harnesses || typeof draft.harnesses !== "object" || Array.isArray(draft.harnesses)) {
          draft.harnesses = {};
        }
        mutator(draft);
        this.inlineConfig = draft;
        this.reload();
        return;
      }

      if (!this.configPath) {
        throw new Error("No configuration path is configured for persisting ACP harness changes.");
      }

      let draft = {};
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf8");
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("root value must be a JSON object");
          }
          draft = parsed;
        } catch (err) {
          throw new Error(
            `Cannot update "${this.configPath}" because existing JSON is invalid: ${err.message}. Please fix the file first.`,
          );
        }
      }

      if (!draft.harnesses || typeof draft.harnesses !== "object" || Array.isArray(draft.harnesses)) {
        draft.harnesses = {};
      }

      mutator(draft);

      const dir = dirname(this.configPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(
        dir,
        `.acp-harnesses.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      );
      const serialized = `${JSON.stringify(draft, null, 2)}\n`;

      try {
        writeFileSync(tmpPath, serialized, "utf8");
        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            renameSync(tmpPath, this.configPath);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (process.platform === "win32" && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY")) {
              await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
        if (lastErr) {
          throw lastErr;
        }
      } catch (err) {
        try {
          if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
        } catch {
          // ignore cleanup failure
        }
        throw err;
      }

      this.reload();
    };

    const next = this._writeQueue.then(run, run);
    this._writeQueue = next.catch(() => {});
    return next;
  }

  async setHarnessEnabled(harnessId, enabled) {
    this.reloadIfChanged();
    if (!this.harnesses.has(harnessId)) {
      throw new Error(`Unknown ACP harness "${harnessId}".`);
    }
    const nextEnabled = Boolean(enabled);
    await this.updateConfig((draft) => {
      const existing =
        draft.harnesses[harnessId] &&
        typeof draft.harnesses[harnessId] === "object" &&
        !Array.isArray(draft.harnesses[harnessId])
          ? draft.harnesses[harnessId]
          : {};
      draft.harnesses[harnessId] = {
        ...existing,
        enabled: nextEnabled,
      };
    });
    return this.get(harnessId);
  }

  async setDefaultHarness(harnessId) {
    this.reloadIfChanged();
    if (!this.harnesses.has(harnessId)) {
      throw new Error(`Unknown ACP harness "${harnessId}".`);
    }
    await this.updateConfig((draft) => {
      draft.defaultHarness = harnessId;
    });
    return this.defaultHarness;
  }

  /**
   * Resolve how to spawn a harness right now without launching it.
   */
  resolveExecution(entry, env = process.env) {
    if (!entry) {
      return {
        installed: false,
        runnable: false,
        resolution: "unknown",
        displayCommand: "",
        installHint: "",
      };
    }

    const effectiveEnv = { ...env, ...(entry.env ?? {}) };

    // Case 1: Explicit command configured by user
    if (entry.command) {
      const expandedArgs = expandArgPlaceholders(entry.args ?? [], this.serverDir);
      const isNodeCmd = entry.command === "node" || entry.command === process.execPath;
      const found = isNodeCmd
        ? process.execPath
        : findExecutableInPath(entry.command, effectiveEnv);

      if (!found) {
        return {
          installed: false,
          runnable: false,
          resolution: "missing",
          displayCommand: [entry.command, ...expandedArgs].join(" "),
          installHint: entry.installHint || `Ensure "${entry.command}" is installed and on PATH.`,
        };
      }

      const spawnSpec = buildSpawnSpec(found, expandedArgs);
      return {
        installed: true,
        runnable: true,
        resolution: "configured",
        executable: found,
        spawnCommand: spawnSpec.command,
        spawnArgs: spawnSpec.args,
        displayCommand: [entry.command, ...expandedArgs].join(" "),
        installHint: entry.installHint || "",
      };
    }

    // Case 2: Preset auto-discovery chain
    for (const resolver of entry.resolvers ?? []) {
      if (resolver.type === "command") {
        const found = findExecutableInPath(resolver.command, effectiveEnv);
        if (found) {
          const spawnSpec = buildSpawnSpec(found, resolver.args ?? []);
          return {
            installed: true,
            runnable: true,
            resolution: "binary",
            executable: found,
            spawnCommand: spawnSpec.command,
            spawnArgs: spawnSpec.args,
            displayCommand: [resolver.command, ...(resolver.args ?? [])].join(" "),
            installHint: entry.installHint || "",
          };
        }
      } else if (resolver.type === "local_pkg") {
        const entryFile = resolveLocalPackageEntry(
          resolver.pkg,
          resolver.entry || "dist/index.js",
          this.serverDir,
        );
        if (entryFile) {
          return {
            installed: true,
            runnable: true,
            resolution: "local_pkg",
            executable: entryFile,
            spawnCommand: process.execPath,
            spawnArgs: [entryFile, ...(resolver.args ?? [])],
            displayCommand: `node ${resolver.pkg}`,
            installHint: entry.installHint || "",
          };
        }
      }
    }

    // Case 3: Optional npx fallback (only when explicitly enabled by user)
    if (entry.npxFallback) {
      const npxPath = findExecutableInPath("npx", effectiveEnv);
      const npxArgs = ["-y", entry.npxFallback.pkg, ...(entry.npxFallback.args ?? [])];
      if (entry.allowNpxFallback && npxPath) {
        const spawnSpec = buildSpawnSpec(npxPath, npxArgs);
        return {
          installed: false,
          runnable: true,
          canFallbackToNpx: true,
          resolution: "npx-fallback",
          executable: npxPath,
          spawnCommand: spawnSpec.command,
          spawnArgs: spawnSpec.args,
          displayCommand: `npx ${npxArgs.join(" ")}`,
          installHint: entry.installHint || "",
        };
      }
      return {
        installed: false,
        runnable: false,
        canFallbackToNpx: Boolean(npxPath),
        resolution: "missing",
        displayCommand: "",
        installHint:
          entry.installHint ||
          `Install "${entry.npxFallback.pkg}" globally, or set "allowNpxFallback": true in ${this.configPath}.`,
      };
    }

    return {
      installed: false,
      runnable: false,
      canFallbackToNpx: false,
      resolution: "missing",
      displayCommand: "",
      installHint: entry.installHint || "Configure command/args in acp-harnesses.json.",
    };
  }
}
