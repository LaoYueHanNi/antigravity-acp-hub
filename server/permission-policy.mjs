import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const APPROVAL_POLICIES = [
  "read_only",
  "accept_edits",
  "allow_all",
  "reject_all",
];

const READ_ONLY_KINDS = new Set(["read", "search", "fetch", "think"]);
const EDIT_KINDS = new Set(["edit"]);
const KNOWN_NON_READ_KINDS = new Set([
  "edit",
  "delete",
  "move",
  "execute",
  "switch_mode",
]);

/**
 * Conservative cross-harness tool name fallbacks used ONLY when ACP toolCall.kind
 * is absent or "other". Unknown tools are always denied (fail-closed).
 */
const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "read_text_file",
  "view_file",
  "cat",
  "glob",
  "grep",
  "ripgrep",
  "rg",
  "search",
  "search_files",
  "find",
  "find_files",
  "ls",
  "list_dir",
  "list_directory",
  "list_files",
  "web_fetch",
  "web_search",
  "fetch",
  "todo_read",
  "get_diagnostics",
]);

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "write",
  "write_file",
  "write_text_file",
  "create_file",
  "multi_edit",
  "notebook_edit",
  "patch",
  "apply_patch",
  "replace",
  "replace_in_file",
  "str_replace",
  "str_replace_editor",
]);

/**
 * Normalize camelCase / PascalCase / kebab-case tool names to lowercase snake_case.
 */
export function normalizeToolName(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  return rawName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Extract normalized tool metadata from ACP tool_call / request_permission payloads
 * without relying on any single vendor's private _meta fields.
 */
export function extractToolMeta(tc = {}, tracked = {}) {
  const rawName =
    tc.name ??
    tc._meta?.claudeCode?.toolName ??
    tc._meta?.toolName ??
    tracked.toolName ??
    tc.title ??
    tracked.title ??
    "unknown";

  const kind = String(tc.kind ?? tracked.kind ?? "").trim().toLowerCase();
  const title = tc.title ?? tracked.title ?? "";
  const locations = tc.locations ?? tracked.locations ?? [];

  return {
    toolCallId: tc.toolCallId ?? tracked.toolCallId ?? "",
    toolName: String(rawName),
    kind,
    title: String(title),
    locations,
    rawInput: tc.rawInput ?? tracked.rawInput,
  };
}

export function isReadOnlyTool(toolMeta) {
  const kind = String(toolMeta?.kind ?? "").trim().toLowerCase();
  if (kind && kind !== "other") {
    if (READ_ONLY_KINDS.has(kind)) return true;
    if (KNOWN_NON_READ_KINDS.has(kind)) return false;
    // Unknown non-empty kind -> fail-closed
    return false;
  }
  const normalized = normalizeToolName(toolMeta?.toolName);
  return READ_ONLY_TOOL_NAMES.has(normalized);
}

export function isEditTool(toolMeta) {
  const kind = String(toolMeta?.kind ?? "").trim().toLowerCase();
  if (kind && kind !== "other") {
    return EDIT_KINDS.has(kind);
  }
  const normalized = normalizeToolName(toolMeta?.toolName);
  return EDIT_TOOL_NAMES.has(normalized);
}

/**
 * Decide how to respond to an ACP session/request_permission callback under the
 * active approval_policy.
 *
 * Security invariants:
 * - Prefers allow_once / reject_once so per-turn overrides never permanently
 *   escalate future turns.
 * - Defaults to fail-closed (read_only) for unknown policies, kinds, or tool names.
 * - Under accept_edits, delete / move / execute are still blocked for user confirmation.
 */
export function decideApprovalOption(policy, toolMeta, options = []) {
  const effectivePolicy = APPROVAL_POLICIES.includes(policy) ? policy : "read_only";
  const allowOption =
    options.find((opt) => opt.kind === "allow_once") ??
    options.find((opt) => opt.kind === "allow_always");
  const rejectOption =
    options.find((opt) => opt.kind === "reject_once") ??
    options.find((opt) => opt.kind === "reject_always");

  let approved = false;
  if (effectivePolicy === "allow_all") {
    approved = Boolean(allowOption);
  } else if (effectivePolicy === "reject_all") {
    approved = false;
  } else if (effectivePolicy === "accept_edits") {
    approved = isReadOnlyTool(toolMeta) || isEditTool(toolMeta);
  } else {
    approved = isReadOnlyTool(toolMeta);
  }

  if (approved && allowOption) {
    return {
      approved: true,
      outcome: { outcome: "selected", optionId: allowOption.optionId },
    };
  }
  if (rejectOption) {
    return {
      approved: false,
      outcome: { outcome: "selected", optionId: rejectOption.optionId },
    };
  }
  return {
    approved: false,
    outcome: { outcome: "cancelled" },
  };
}

/**
 * Policy gate for optional Client-side fs / terminal proxy handlers.
 */
export function canClientOperationProceed(policy, opType) {
  const effectivePolicy = APPROVAL_POLICIES.includes(policy) ? policy : "read_only";
  if (effectivePolicy === "reject_all") return false;
  if (opType === "fs_read") return true;
  if (opType === "fs_write") {
    return effectivePolicy === "accept_edits" || effectivePolicy === "allow_all";
  }
  if (opType === "terminal") {
    return effectivePolicy === "allow_all";
  }
  return false;
}

/**
 * Resolve a path through symlinks even when the leaf file does not exist yet
 * (walks up to the nearest existing ancestor).
 */
function resolveRealPathBestEffort(targetPath) {
  const abs = resolve(targetPath);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  const missingSegments = [];
  let cursor = abs;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ""));
    cursor = parent;
    if (existsSync(cursor)) {
      try {
        const realBase = realpathSync(cursor);
        return join(realBase, ...missingSegments);
      } catch {
        return abs;
      }
    }
  }
  return abs;
}

/**
 * Check whether targetPath stays inside at least one allowed workspace root.
 */
export function isPathAllowed(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== "string" || !isAbsolute(targetPath)) {
    return false;
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return false;
  }

  const realTarget = resolveRealPathBestEffort(targetPath);
  const isWin = process.platform === "win32";
  const cmpTarget = isWin ? realTarget.toLowerCase() : realTarget;

  for (const root of allowedRoots) {
    if (!root || !isAbsolute(root)) continue;
    const realRoot = resolveRealPathBestEffort(root);
    const cmpRoot = isWin ? realRoot.toLowerCase() : realRoot;
    const rel = relative(cmpRoot, cmpTarget);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}
