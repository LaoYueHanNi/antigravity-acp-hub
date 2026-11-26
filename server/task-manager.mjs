import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  classifyFileAction,
  extractDiffPreview,
  extractPathsFromToolMeta,
} from "./permission-policy.mjs";

const MAX_TASKS = 30;
const MAX_TURNS_PER_TASK = 40;
const MAX_TEXT_CHARS = 120_000;
const MAX_THOUGHT_CHARS = 60_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000;
const PERSIST_DEBOUNCE_MS = 1_500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function getDefaultTasksStorePath() {
  return process.env.ACP_HUB_TASKS_PATH || join(homedir(), ".gemini", "config", "acp-tasks.json");
}

function summarizeInput(rawInput) {
  if (rawInput == null) return "";
  try {
    const serialized = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
    return serialized.length > 260 ? `${serialized.slice(0, 260)}...` : serialized;
  } catch {
    return String(rawInput);
  }
}

function appendBounded(current, chunk, maxChars) {
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

function deriveTaskTitle(prompt, explicitTitle) {
  if (explicitTitle && String(explicitTitle).trim()) {
    return String(explicitTitle).trim().slice(0, 80);
  }
  const firstLine = String(prompt ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "ACP 会话任务";
  return firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine;
}

function normalizeFilePath(cwd, rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  // Ignore glob patterns so the Files Touched list stays clickable for fileView.
  if (/[*?[\]{}]/.test(trimmed)) return null;
  try {
    const abs = isAbsolute(trimmed) ? resolve(trimmed) : cwd ? resolve(cwd, trimmed) : trimmed;
    const displayPath = cwd ? relative(cwd, abs) || abs : abs;
    return {
      key: process.platform === "win32" ? abs.toLowerCase() : abs,
      path: abs,
      displayPath: displayPath.startsWith("..") ? abs : displayPath,
    };
  } catch {
    return null;
  }
}

function selectApprovalOption(options = [], kindPreference = []) {
  for (const kind of kindPreference) {
    const found = options.find((opt) => opt.kind === kind);
    if (found) return found;
  }
  return null;
}

/**
 * Task registry, real-time stream recorder, touched-files aggregator,
 * interactive approval queue, wait-notifier, and atomic JSON persistence
 * for ACP Hub tasks.
 */
export class TaskManager {
  constructor({
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    persistPath = undefined,
  } = {}) {
    this.approvalTimeoutMs = approvalTimeoutMs;
    // persistPath === null explicitly disables disk persistence (e.g. unit tests)
    this.persistPath = persistPath === undefined ? getDefaultTasksStorePath() : persistPath;
    this.tasks = new Map();
    this.taskOrder = [];
    this.sessionTaskIndex = new Map();
    this.approvals = new Map();
    this.waiters = new Map();
    this.taskSeq = 0;
    this.approvalSeq = 0;
    this.persistTimer = null;
    this.loadWarning = null;

    if (this.persistPath) {
      this.#loadFromDisk();
    }
  }

  #loadFromDisk() {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tasks)) return;

      const restoredTasks = parsed.tasks.slice(-MAX_TASKS);
      let maxSeqNum = 0;

      for (const item of restoredTasks) {
        if (!item?.taskId || !item?.harness) continue;
        const seqMatch = String(item.taskId).match(/^task_(\d+)_/);
        if (seqMatch) {
          maxSeqNum = Math.max(maxSeqNum, Number(seqMatch[1]) || 0);
        }

        const wasInterrupted = !TERMINAL_STATUSES.has(item.status);
        const turns = Array.isArray(item.turns)
          ? item.turns.slice(-MAX_TURNS_PER_TASK).map((t, idx) => {
              const tcMap = new Map();
              for (const tc of t.toolCalls ?? []) {
                if (!tc?.toolCallId) continue;
                tcMap.set(tc.toolCallId, tc);
              }
              const turnInterrupted = !TERMINAL_STATUSES.has(t.status);
              return {
                turnIndex: t.turnIndex ?? idx + 1,
                source: t.source ?? "model",
                prompt: String(t.prompt ?? ""),
                approvalPolicy: t.approvalPolicy ?? item.approvalPolicy ?? "interactive",
                status: turnInterrupted ? "cancelled" : t.status,
                startedAt: t.startedAt ?? item.createdAt ?? Date.now(),
                finishedAt: t.finishedAt ?? item.updatedAt ?? Date.now(),
                text: String(t.text ?? ""),
                thought: String(t.thought ?? ""),
                toolCalls: tcMap,
                plan: Array.isArray(t.plan) ? t.plan : null,
                deniedPermissions: Array.isArray(t.deniedPermissions)
                  ? t.deniedPermissions
                  : [],
                elicitations: Array.isArray(t.elicitations) ? t.elicitations : [],
                warnings: Array.isArray(t.warnings) ? t.warnings : [],
                stopReason: turnInterrupted ? "server_restart" : t.stopReason ?? null,
                error: turnInterrupted
                  ? "ACP Hub 服务重启，运行中回合已中断"
                  : t.error ?? null,
              };
            })
          : [];

        const filesMap = new Map();
        for (const f of item.files ?? []) {
          if (!f?.path) continue;
          const key = process.platform === "win32" ? f.path.toLowerCase() : f.path;
          filesMap.set(key, {
            path: f.path,
            displayPath: f.displayPath || f.path,
            actions: new Set(Array.isArray(f.actions) ? f.actions : ["other"]),
            lastToolName: f.lastToolName || "unknown",
            updatedAt: f.updatedAt ?? item.updatedAt ?? Date.now(),
          });
        }

        const task = {
          taskId: item.taskId,
          sessionId: item.sessionId ?? null,
          harness: item.harness,
          harnessDisplayName: item.harnessDisplayName || item.harness,
          cwd: item.cwd || "",
          title: item.title || "ACP 历史任务",
          status: wasInterrupted ? "cancelled" : item.status,
          sessionClosed: true,
          restoredFromDisk: true,
          createdAt: item.createdAt ?? Date.now(),
          updatedAt: item.updatedAt ?? Date.now(),
          startedAt: item.startedAt ?? item.createdAt ?? Date.now(),
          finishedAt: item.finishedAt ?? item.updatedAt ?? Date.now(),
          mode: item.mode ?? null,
          model: item.model ?? null,
          approvalPolicy: item.approvalPolicy ?? "interactive",
          stopReason: wasInterrupted ? "server_restart" : item.stopReason ?? null,
          error: wasInterrupted
            ? "ACP Hub 服务重启，运行中回合已中断"
            : item.error ?? null,
          turns,
          files: filesMap,
          pendingApprovals: new Map(),
          seq: Math.max(1, Number(item.seq) || 1),
        };

        this.tasks.set(task.taskId, task);
        this.taskOrder.push(task.taskId);
        if (task.sessionId) {
          this.sessionTaskIndex.set(task.sessionId, task.taskId);
        }
      }

      this.taskSeq = Math.max(this.taskSeq, maxSeqNum);
    } catch (err) {
      this.loadWarning = `Failed to load persisted ACP tasks: ${err.message}`;
    }
  }

  #schedulePersist(immediate = false) {
    if (!this.persistPath) return;
    if (immediate) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.#flushPersistSync();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.#flushPersistSync();
    }, PERSIST_DEBOUNCE_MS);
  }

  #flushPersistSync() {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        savedAt: Date.now(),
        tasks: this.taskOrder
          .map((id) => this.tasks.get(id))
          .filter(Boolean)
          .map((task) => {
            const detail = this.serializeTaskDetail(task);
            // Never persist ephemeral pendingApprovals across restarts
            delete detail.pendingApprovals;
            return detail;
          }),
      };
      const tmpPath = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      try {
        renameSync(tmpPath, this.persistPath);
      } catch (renameErr) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        throw renameErr;
      }
    } catch {
      // Best-effort persistence: never crash live ACP turns on transient disk errors.
    }
  }

  #bumpTask(task, { immediatePersist = false } = {}) {
    task.updatedAt = Date.now();
    task.seq += 1;
    this.#notifyWaiters(task);
    this.#schedulePersist(immediatePersist);
  }

  #notifyWaiters(task) {
    const listeners = this.waiters.get(task.taskId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of Array.from(listeners)) {
      listener(task);
    }
  }

  #evictIfNeeded() {
    while (this.taskOrder.length > MAX_TASKS) {
      // Never evict running or waiting_approval tasks.
      const evictIndex = this.taskOrder.findIndex((id) => {
        const t = this.tasks.get(id);
        return t && TERMINAL_STATUSES.has(t.status) && t.pendingApprovals.size === 0;
      });
      if (evictIndex === -1) {
        break;
      }
      const [evictedId] = this.taskOrder.splice(evictIndex, 1);
      const evicted = this.tasks.get(evictedId);
      if (evicted) {
        this.cancelPendingApprovalsForTask(evictedId, "Task evicted from history cache.");
        if (this.sessionTaskIndex.get(evicted.sessionId) === evictedId) {
          this.sessionTaskIndex.delete(evicted.sessionId);
        }
        this.tasks.delete(evictedId);
        this.waiters.delete(evictedId);
      }
    }
  }

  createTask({
    sessionId,
    harness,
    harnessDisplayName = null,
    cwd,
    title = null,
    prompt = "",
    mode = null,
    model = null,
    approvalPolicy = "read_only",
  }) {
    this.taskSeq += 1;
    const suffix = randomBytes(2).toString("hex");
    const taskId = `task_${this.taskSeq}_${suffix}`;
    const now = Date.now();

    const task = {
      taskId,
      sessionId,
      harness,
      harnessDisplayName: harnessDisplayName || harness,
      cwd,
      title: deriveTaskTitle(prompt, title),
      status: "running",
      sessionClosed: false,
      restoredFromDisk: false,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      mode,
      model,
      approvalPolicy,
      stopReason: null,
      error: null,
      turns: [],
      files: new Map(),
      pendingApprovals: new Map(),
      seq: 1,
    };

    this.tasks.set(taskId, task);
    this.taskOrder.push(taskId);
    if (sessionId) {
      this.sessionTaskIndex.set(sessionId, taskId);
    }
    this.#evictIfNeeded();
    this.#schedulePersist(true);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  findTaskBySession(sessionId) {
    const taskId = this.sessionTaskIndex.get(sessionId);
    if (!taskId) return null;
    return this.tasks.get(taskId) ?? null;
  }

  getOrCreateTaskForSession({
    sessionId,
    harness,
    harnessDisplayName,
    cwd,
    prompt,
    title,
    mode,
    model,
    approvalPolicy,
  }) {
    const existing = this.findTaskBySession(sessionId);
    if (existing) {
      if (title && String(title).trim()) {
        existing.title = deriveTaskTitle(prompt, title);
      }
      if (mode !== undefined) existing.mode = mode;
      if (model !== undefined) existing.model = model;
      if (approvalPolicy) existing.approvalPolicy = approvalPolicy;
      existing.sessionClosed = false;
      existing.restoredFromDisk = false;
      return existing;
    }
    return this.createTask({
      sessionId,
      harness,
      harnessDisplayName,
      cwd,
      title,
      prompt,
      mode,
      model,
      approvalPolicy,
    });
  }

  markSessionReopened(taskId, { sessionId, mode, model } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (sessionId) {
      task.sessionId = sessionId;
      this.sessionTaskIndex.set(sessionId, taskId);
    }
    task.sessionClosed = false;
    task.restoredFromDisk = false;
    if (mode !== undefined) task.mode = mode;
    if (model !== undefined) task.model = model;
    this.#bumpTask(task, { immediatePersist: true });
  }

  startTurn(taskId, { prompt, source = "model", approvalPolicy, mode, model }) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown ACP task "${taskId}".`);
    }
    const now = Date.now();
    const lastIdx = task.turns[task.turns.length - 1]?.turnIndex ?? 0;
    const turnIndex = lastIdx + 1;
    const turnRecord = {
      turnIndex,
      source,
      prompt: String(prompt ?? ""),
      approvalPolicy: approvalPolicy ?? task.approvalPolicy,
      status: "running",
      startedAt: now,
      finishedAt: null,
      text: "",
      thought: "",
      toolCalls: new Map(),
      plan: null,
      deniedPermissions: [],
      elicitations: [],
      warnings: [],
      stopReason: null,
      error: null,
    };
    task.turns.push(turnRecord);
    if (task.turns.length > MAX_TURNS_PER_TASK) {
      task.turns.splice(0, task.turns.length - MAX_TURNS_PER_TASK);
    }
    task.status = "running";
    task.stopReason = null;
    task.error = null;
    task.finishedAt = null;
    if (!task.startedAt) task.startedAt = now;
    if (approvalPolicy) task.approvalPolicy = approvalPolicy;
    if (mode !== undefined) task.mode = mode;
    if (model !== undefined) task.model = model;
    this.#bumpTask(task, { immediatePersist: true });
    return turnRecord;
  }

  #getTurn(taskId, turnIndex) {
    const task = this.tasks.get(taskId);
    if (!task) return { task: null, turn: null };
    const turn = task.turns.find((t) => t.turnIndex === turnIndex) ?? null;
    return { task, turn };
  }

  updateTurnPolicy(taskId, turnIndex, policy) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn || !policy) return;
    turn.approvalPolicy = policy;
    task.approvalPolicy = policy;
    this.#bumpTask(task);
  }

  appendMessageChunk(taskId, turnIndex, text) {
    if (!text) return;
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    turn.text = appendBounded(turn.text, text, MAX_TEXT_CHARS);
    this.#bumpTask(task);
  }

  appendThoughtChunk(taskId, turnIndex, text) {
    if (!text) return;
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    turn.thought = appendBounded(turn.thought, text, MAX_THOUGHT_CHARS);
    this.#bumpTask(task);
  }

  upsertToolCall(taskId, turnIndex, toolMeta, status) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    const id = toolMeta.toolCallId || `tc_${turn.toolCalls.size + 1}`;
    const existing = turn.toolCalls.get(id);
    const now = Date.now();
    const rawLocations = extractPathsFromToolMeta(toolMeta);
    const resolvedLocations = rawLocations
      .map((rawPath) => normalizeFilePath(task.cwd, rawPath)?.path ?? rawPath)
      .filter(Boolean);
    const preview = extractDiffPreview(toolMeta) ?? existing?.preview ?? null;

    const entry = {
      toolCallId: id,
      toolName: toolMeta.toolName || existing?.toolName || "unknown",
      kind: toolMeta.kind || existing?.kind || "",
      title: toolMeta.title || existing?.title || "",
      status: status || existing?.status || "pending",
      locations:
        resolvedLocations.length > 0 ? resolvedLocations : existing?.locations ?? [],
      inputSummary:
        toolMeta.rawInput != null
          ? summarizeInput(toolMeta.rawInput)
          : existing?.inputSummary ?? "",
      preview,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    };
    turn.toolCalls.set(id, entry);

    const action = classifyFileAction(toolMeta);
    for (const rawPath of rawLocations) {
      const normalized = normalizeFilePath(task.cwd, rawPath);
      if (!normalized) continue;
      const existingFile = task.files.get(normalized.key);
      if (existingFile) {
        existingFile.actions.add(action);
        existingFile.lastToolName = entry.toolName;
        existingFile.updatedAt = now;
      } else {
        task.files.set(normalized.key, {
          path: normalized.path,
          displayPath: normalized.displayPath,
          actions: new Set([action]),
          lastToolName: entry.toolName,
          updatedAt: now,
        });
      }
    }

    this.#bumpTask(task);
  }

  updatePlan(taskId, turnIndex, entries) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn || !Array.isArray(entries)) return;
    turn.plan = entries.map((e) => ({
      content: String(e?.content ?? ""),
      status: String(e?.status ?? "pending"),
      priority: e?.priority ?? null,
    }));
    this.#bumpTask(task);
  }

  updateSessionMeta(taskId, { mode, model }) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    let changed = false;
    if (mode !== undefined && mode !== task.mode) {
      task.mode = mode;
      changed = true;
    }
    if (model !== undefined && model !== task.model) {
      task.model = model;
      changed = true;
    }
    if (changed) {
      this.#bumpTask(task);
    }
  }

  recordDeniedPermission(taskId, turnIndex, item) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    turn.deniedPermissions.push(item);
    this.#bumpTask(task);
  }

  recordElicitation(taskId, turnIndex, item) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    turn.elicitations.push(item);
    this.#bumpTask(task);
  }

  finishTurn(
    taskId,
    turnIndex,
    { status = "completed", stopReason = null, warnings = [], error = null, mode, model } = {},
  ) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) return;
    if (TERMINAL_STATUSES.has(turn.status)) return;

    this.cancelPendingApprovalsForTask(taskId, "Turn finished.");
    const now = Date.now();
    turn.status = status;
    turn.stopReason = stopReason;
    turn.warnings = warnings ?? [];
    turn.error = error;
    turn.finishedAt = now;

    // H3 guard: only mark the overall task terminal if no other turn is still active.
    const hasOtherActiveTurn = task.turns.some(
      (t) => t !== turn && !TERMINAL_STATUSES.has(t.status),
    );
    if (!hasOtherActiveTurn) {
      task.status = status;
      task.stopReason = stopReason;
      task.error = error;
      task.finishedAt = now;
    }
    if (mode !== undefined) task.mode = mode;
    if (model !== undefined) task.model = model;

    this.#bumpTask(task, { immediatePersist: true });
  }

  /**
   * Suspend an ACP session/request_permission callback until a human approves or
   * rejects it in the aux_pane (or until timeout / cancellation fails closed).
   */
  requestInteractiveApproval({
    taskId,
    turnIndex,
    harness,
    toolMeta,
    options = [],
    timeoutMs = this.approvalTimeoutMs,
  }) {
    const { task, turn } = this.#getTurn(taskId, turnIndex);
    if (!task || !turn) {
      return Promise.resolve({
        approved: false,
        decision: "reject",
        outcome: { outcome: "cancelled" },
      });
    }

    this.approvalSeq += 1;
    const approvalId = `apr_${this.approvalSeq}_${randomBytes(2).toString("hex")}`;
    const now = Date.now();
    const effectiveTimeout = Math.max(1_000, timeoutMs ?? this.approvalTimeoutMs);
    const locations = extractPathsFromToolMeta(toolMeta)
      .map((rawPath) => normalizeFilePath(task.cwd, rawPath)?.path ?? rawPath)
      .filter(Boolean);
    const preview = extractDiffPreview(toolMeta);
    const hasAllowOnce = options.some((opt) => opt.kind === "allow_once");

    return new Promise((resolvePromise) => {
      const entry = {
        approvalId,
        taskId,
        turnIndex,
        harness,
        toolCallId: toolMeta.toolCallId ?? "",
        toolName: toolMeta.toolName ?? "unknown",
        kind: toolMeta.kind ?? "",
        title: toolMeta.title ?? "",
        locations,
        inputSummary: summarizeInput(toolMeta.rawInput),
        preview,
        willPersistAllow: !hasAllowOnce && options.some((opt) => opt.kind === "allow_always"),
        options: options.map((opt) => ({
          optionId: opt.optionId,
          name: opt.name ?? opt.kind ?? opt.optionId,
          kind: opt.kind ?? "",
        })),
        createdAt: now,
        expiresAt: now + effectiveTimeout,
        settled: false,
        timer: null,
        resolve: resolvePromise,
      };

      const settle = (result) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        this.approvals.delete(approvalId);
        task.pendingApprovals.delete(approvalId);
        if (task.pendingApprovals.size === 0 && task.status === "waiting_approval") {
          task.status = "running";
        }
        if (turn.status === "waiting_approval") {
          turn.status = "running";
        }
        this.#bumpTask(task);
        resolvePromise(result);
      };

      entry.settle = settle;
      entry.timer = setTimeout(() => {
        const rejectOpt = selectApprovalOption(entry.options, ["reject_once", "reject_always"]);
        settle({
          approved: false,
          decision: "timeout",
          timedOut: true,
          outcome: rejectOpt
            ? { outcome: "selected", optionId: rejectOpt.optionId }
            : { outcome: "cancelled" },
        });
      }, effectiveTimeout);

      this.approvals.set(approvalId, entry);
      task.pendingApprovals.set(approvalId, entry);
      task.status = "waiting_approval";
      turn.status = "waiting_approval";

      this.#bumpTask(task);
    });
  }

  resolveApproval(approvalId, decision) {
    const entry = this.approvals.get(approvalId);
    if (!entry || entry.settled) {
      throw new Error(`Approval "${approvalId}" is no longer pending.`);
    }

    const allowedDecisions = new Set([
      "allow_once",
      "allow_edits_turn",
      "allow_all_turn",
      "reject",
    ]);
    if (!allowedDecisions.has(decision)) {
      throw new Error(
        `Invalid approval decision "${decision}". Expected one of: ${Array.from(allowedDecisions).join(", ")}.`,
      );
    }

    if (decision === "reject") {
      const rejectOpt = selectApprovalOption(entry.options, ["reject_once", "reject_always"]);
      entry.settle({
        approved: false,
        decision: "reject",
        outcome: rejectOpt
          ? { outcome: "selected", optionId: rejectOpt.optionId }
          : { outcome: "cancelled" },
      });
      return {
        resolved: true,
        approvalId,
        taskId: entry.taskId,
        decision,
        approved: false,
      };
    }

    const allowOpt = selectApprovalOption(entry.options, ["allow_once", "allow_always"]);
    if (!allowOpt) {
      entry.settle({
        approved: false,
        decision: "reject",
        outcome: { outcome: "cancelled" },
      });
      return {
        resolved: true,
        approvalId,
        taskId: entry.taskId,
        decision: "reject",
        approved: false,
      };
    }

    // H2 fix: allow_edits_turn escalates to interactive_edits (auto-allows edits,
    // still prompts interactively for execute/delete/move/unknown).
    const escalateToPolicy =
      decision === "allow_edits_turn"
        ? "interactive_edits"
        : decision === "allow_all_turn"
          ? "allow_all"
          : null;

    entry.settle({
      approved: true,
      decision,
      escalateToPolicy,
      outcome: { outcome: "selected", optionId: allowOpt.optionId },
    });

    return {
      resolved: true,
      approvalId,
      taskId: entry.taskId,
      decision,
      approved: true,
      escalateToPolicy,
    };
  }

  cancelPendingApprovalsForTask(taskId, reason = "Cancelled.") {
    const task = this.tasks.get(taskId);
    if (!task) return 0;
    let count = 0;
    for (const entry of Array.from(task.pendingApprovals.values())) {
      count += 1;
      entry.settle({
        approved: false,
        decision: "cancelled",
        cancelled: true,
        reason,
        outcome: { outcome: "cancelled" },
      });
    }
    return count;
  }

  markSessionClosed(sessionId, { reason = "Session closed.", markRunningAsFailed = false } = {}) {
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      task.sessionClosed = true;
      this.cancelPendingApprovalsForTask(task.taskId, reason);
      if (markRunningAsFailed && !TERMINAL_STATUSES.has(task.status)) {
        const lastTurn = task.turns[task.turns.length - 1];
        if (lastTurn && !TERMINAL_STATUSES.has(lastTurn.status)) {
          lastTurn.status = "failed";
          lastTurn.error = reason;
          lastTurn.finishedAt = Date.now();
        }
        task.status = "failed";
        task.error = reason;
        task.finishedAt = Date.now();
      }
      this.#bumpTask(task, { immediatePersist: true });
    }
  }

  waitForTask(taskId, { timeoutSeconds = 120, returnOnApproval = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown ACP task "${taskId}".`);
    }

    const boundedTimeout = Math.min(Math.max(1, timeoutSeconds ?? 120), 150);

    const isReady = (t) =>
      TERMINAL_STATUSES.has(t.status) ||
      (returnOnApproval && t.status === "waiting_approval");

    if (isReady(task)) {
      return Promise.resolve({
        timedOut: false,
        task: this.serializeTaskDetail(task),
      });
    }

    return new Promise((resolveWait) => {
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const set = this.waiters.get(taskId);
        if (set) {
          set.delete(onUpdate);
          if (set.size === 0) this.waiters.delete(taskId);
        }
      };

      const onUpdate = (updatedTask) => {
        if (settled) return;
        if (isReady(updatedTask)) {
          settled = true;
          cleanup();
          resolveWait({
            timedOut: false,
            task: this.serializeTaskDetail(updatedTask),
          });
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const latest = this.tasks.get(taskId) ?? task;
        resolveWait({
          timedOut: true,
          task: this.serializeTaskDetail(latest),
        });
      }, boundedTimeout * 1000);

      let set = this.waiters.get(taskId);
      if (!set) {
        set = new Set();
        this.waiters.set(taskId, set);
      }
      set.add(onUpdate);
    });
  }

  serializeTaskSummary(task) {
    const lastTurn = task.turns[task.turns.length - 1] ?? null;
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      harness: task.harness,
      harnessDisplayName: task.harnessDisplayName,
      cwd: task.cwd,
      title: task.title,
      status: task.status,
      sessionClosed: task.sessionClosed,
      restoredFromDisk: Boolean(task.restoredFromDisk),
      mode: task.mode,
      model: task.model,
      approvalPolicy: task.approvalPolicy,
      turnCount: task.turns.length,
      fileCount: task.files.size,
      pendingApprovalCount: task.pendingApprovals.size,
      stopReason: task.stopReason,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      seq: task.seq,
      lastTextPreview: lastTurn?.text ? lastTurn.text.slice(-180) : "",
    };
  }

  serializeTaskDetail(task) {
    const turns = task.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      source: turn.source,
      prompt: turn.prompt,
      approvalPolicy: turn.approvalPolicy,
      status: turn.status,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      text: turn.text,
      thought: turn.thought,
      toolCalls: Array.from(turn.toolCalls.values()),
      plan: turn.plan,
      deniedPermissions: turn.deniedPermissions,
      elicitations: turn.elicitations,
      warnings: turn.warnings,
      stopReason: turn.stopReason,
      error: turn.error,
    }));

    const files = Array.from(task.files.values())
      .map((f) => ({
        path: f.path,
        displayPath: f.displayPath,
        actions: Array.from(f.actions),
        lastToolName: f.lastToolName,
        updatedAt: f.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const pendingApprovals = Array.from(task.pendingApprovals.values()).map((a) => ({
      approvalId: a.approvalId,
      taskId: a.taskId,
      turnIndex: a.turnIndex,
      harness: a.harness,
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      kind: a.kind,
      title: a.title,
      locations: a.locations,
      inputSummary: a.inputSummary,
      preview: a.preview,
      willPersistAllow: Boolean(a.willPersistAllow),
      options: a.options,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    }));

    return {
      ...this.serializeTaskSummary(task),
      turns,
      files,
      pendingApprovals,
    };
  }

  getWorkspaceSnapshot({ activeTaskId = null, sessionId = null } = {}) {
    const orderedTasks = [...this.taskOrder]
      .reverse()
      .map((id) => this.tasks.get(id))
      .filter(Boolean);

    let active = null;
    if (activeTaskId) {
      active = this.tasks.get(activeTaskId) ?? null;
    } else if (sessionId) {
      active = this.findTaskBySession(sessionId);
    }
    if (!active && orderedTasks.length > 0) {
      active =
        orderedTasks.find((t) => t.pendingApprovals.size > 0) ??
        orderedTasks.find((t) => t.status === "running") ??
        orderedTasks[0];
    }

    let runningCount = 0;
    let waitingApprovalCount = 0;
    for (const t of orderedTasks) {
      if (t.status === "running" || t.status === "waiting_approval") runningCount += 1;
      if (t.pendingApprovals.size > 0) waitingApprovalCount += t.pendingApprovals.size;
    }

    return {
      serverTime: Date.now(),
      totalTasks: orderedTasks.length,
      runningCount,
      waitingApprovalCount,
      activeTaskId: active?.taskId ?? null,
      tasks: orderedTasks.map((t) => this.serializeTaskSummary(t)),
      activeTask: active ? this.serializeTaskDetail(active) : null,
    };
  }

  pollTask(taskId = null, { sinceSeq = 0 } = {}) {
    const orderedTasks = [...this.taskOrder]
      .reverse()
      .map((id) => this.tasks.get(id))
      .filter(Boolean);

    let target = taskId ? this.tasks.get(taskId) ?? null : null;
    if (!target && orderedTasks.length > 0) {
      target =
        orderedTasks.find((t) => t.pendingApprovals.size > 0) ??
        orderedTasks.find((t) => t.status === "running") ??
        orderedTasks[0];
    }

    let runningCount = 0;
    let waitingApprovalCount = 0;
    for (const t of orderedTasks) {
      if (t.status === "running" || t.status === "waiting_approval") runningCount += 1;
      if (t.pendingApprovals.size > 0) waitingApprovalCount += t.pendingApprovals.size;
    }

    const unchanged = Boolean(target && target.seq === sinceSeq);

    return {
      serverTime: Date.now(),
      totalTasks: orderedTasks.length,
      runningCount,
      waitingApprovalCount,
      activeTaskId: target?.taskId ?? null,
      unchanged,
      seq: target?.seq ?? 0,
      tasks: orderedTasks.map((t) => this.serializeTaskSummary(t)),
      activeTask: !target || unchanged ? null : this.serializeTaskDetail(target),
    };
  }

  dispose() {
    for (const taskId of Array.from(this.tasks.keys())) {
      this.cancelPendingApprovalsForTask(taskId, "ACP Hub shutting down.");
    }
    this.#schedulePersist(true);
    for (const set of this.waiters.values()) {
      set.clear();
    }
    this.waiters.clear();
    this.approvals.clear();
  }
}
