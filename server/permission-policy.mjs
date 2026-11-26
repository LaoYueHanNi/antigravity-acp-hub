import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const APPROVAL_POLICIES = [
  "read_only",
  "accept_edits",
  "interactive",
  "allow_all",
  "reject_all",
];

// Internal turn-scoped escalation policy: auto-allows read-only + edit tools while
// still prompting interactively in the aux_pane for execute/delete/move/unknown.
export const INTERNAL_APPROVAL_POLICIES = [
  ...APPROVAL_POLICIES,
  "interactive_edits",
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
 * Interactive policy auto-allows read-only tools and pauses for human approval
 * in the aux_pane on any write/edit/delete/move/execute/unknown tool.
 * Under interactive_edits, edit tools are also auto-allowed while execute/delete/move/unknown still prompt.
 */
export function shouldPromptInteractively(policy, toolMeta) {
  if (policy === "interactive") {
    return !isReadOnlyTool(toolMeta);
  }
  if (policy === "interactive_edits") {
    return !isReadOnlyTool(toolMeta) && !isEditTool(toolMeta);
  }
  return false;
}

function truncateText(text, maxLen) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... (truncated ${text.length - maxLen} chars)`;
}

/**
 * Extract a concise, vendor-neutral preview from toolMeta.rawInput for display
 * in approval cards and tool call timelines.
 */
export function extractDiffPreview(toolMeta) {
  const raw = toolMeta?.rawInput;
  if (raw == null) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { type: "text", content: truncateText(trimmed, 1600) } : null;
  }

  if (typeof raw === "object") {
    const command =
      typeof raw.command === "string"
        ? raw.command
        : typeof raw.cmd === "string"
          ? raw.cmd
          : null;
    if (command && command.trim()) {
      return {
        type: "command",
        command: truncateText(command.trim(), 2000),
      };
    }

    const oldText =
      raw.old_string ?? raw.oldString ?? raw.oldText ?? raw.old_str ?? raw.Target ?? null;
    const newText =
      raw.new_string ?? raw.newString ?? raw.newText ?? raw.new_str ?? raw.Replacement ?? null;
    if (typeof oldText === "string" || typeof newText === "string") {
      return {
        type: "diff",
        oldText: truncateText(typeof oldText === "string" ? oldText : "", 1600),
        newText: truncateText(typeof newText === "string" ? newText : "", 1600),
      };
    }

    const patch =
      typeof raw.patch === "string"
        ? raw.patch
        : typeof raw.diff === "string"
          ? raw.diff
          : null;
    if (patch && patch.trim()) {
      return {
        type: "patch",
        patch: truncateText(patch, 2400),
      };
    }

    const content =
      typeof raw.content === "string"
        ? raw.content
        : typeof raw.new_content === "string"
          ? raw.new_content
          : typeof raw.Content === "string"
            ? raw.Content
            : null;
    if (content && content.trim()) {
      return {
        type: "content",
        content: truncateText(content, 2000),
      };
    }

    try {
      const serialized = JSON.stringify(raw, null, 2);
      if (serialized && serialized !== "{}") {
        return {
          type: "json",
          content: truncateText(serialized, 1600),
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

const PATH_INPUT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "Path",
  "target",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "source",
  "destination",
  "dest",
];

/**
 * Extract candidate file paths referenced by an ACP tool call payload.
 */
export function extractPathsFromToolMeta(toolMeta = {}) {
  const seen = new Set();
  const push = (val) => {
    if (typeof val !== "string") return;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > 500 || /[\r\n]/.test(trimmed)) return;
    if (/^https?:\/\//i.test(trimmed)) return;
    seen.add(trimmed);
  };

  for (const loc of toolMeta.locations ?? []) {
    if (typeof loc === "string") push(loc);
    else if (loc && typeof loc.path === "string") push(loc.path);
  }

  const raw = toolMeta.rawInput;
  if (raw && typeof raw === "object") {
    for (const key of PATH_INPUT_KEYS) {
      if (typeof raw[key] === "string") {
        push(raw[key]);
      }
    }
    if (Array.isArray(raw.paths)) {
      for (const item of raw.paths) push(item);
    }
    if (Array.isArray(raw.files)) {
      for (const item of raw.files) {
        if (typeof item === "string") push(item);
        else if (item && typeof item.path === "string") push(item.path);
      }
    }
  }

  return Array.from(seen);
}

/**
 * Classify how a tool call interacted with a file path for UI badges.
 */
export function classifyFileAction(toolMeta = {}) {
  const kind = String(toolMeta?.kind ?? "").trim().toLowerCase();
  if (kind === "delete") return "delete";
  if (kind === "edit" || kind === "move") return "edit";
  if (kind === "read" || kind === "search") return "read";
  if (isEditTool(toolMeta)) return "edit";
  if (isReadOnlyTool(toolMeta)) return "read";
  return "other";
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
  const effectivePolicy = INTERNAL_APPROVAL_POLICIES.includes(policy)
    ? policy
    : "read_only";
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
  } else if (
    effectivePolicy === "accept_edits" ||
    effectivePolicy === "interactive_edits"
  ) {
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
