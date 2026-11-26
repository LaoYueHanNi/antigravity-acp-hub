import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import { AcpConnection } from "./acp-connection.mjs";
import { HarnessRegistry } from "./harness-registry.mjs";
import {
  APPROVAL_POLICIES,
  decideApprovalOption,
  extractToolMeta,
  shouldPromptInteractively,
} from "./permission-policy.mjs";
import { TaskManager } from "./task-manager.mjs";

export { APPROVAL_POLICIES };

const DEFAULT_TIMEOUT_SECONDS = 300;

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join("\n");
  }
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (content.content) {
    return extractTextFromContent(content.content);
  }
  return "";
}

function summarizeInput(rawInput) {
  if (rawInput == null) return "";
  try {
    const serialized = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
    return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
  } catch {
    return String(rawInput);
  }
}

export function formatCompositeSessionId(harnessId, nativeSessionId) {
  return `${harnessId}:${nativeSessionId}`;
}

/**
 * Multi-harness ACP connection pool and stateful session router.
 */
export class AcpHub {
  constructor({
    configPath,
    inlineConfig,
    serverDir,
    initTimeoutMs,
    approvalTimeoutMs,
    tasksStorePath = undefined,
  } = {}) {
    this.registry = new HarnessRegistry({ configPath, inlineConfig, serverDir });
    this.initTimeoutMs = initTimeoutMs;
    this.connections = new Map();
    this.sessions = new Map();
    this.nativeIndex = new Map();
    // Avoid polluting user's real ~/.gemini/config/acp-tasks.json when inlineConfig is used in tests.
    const effectiveTasksPath =
      tasksStorePath !== undefined ? tasksStorePath : inlineConfig ? null : undefined;
    this.taskManager = new TaskManager({
      approvalTimeoutMs,
      persistPath: effectiveTasksPath,
    });
    // Pre-warm PATH resolution cache in the background on server startup so
    // the first dashboard open responds in < 1ms instead of scanning PATH synchronously.
    if (!inlineConfig) {
      setImmediate(() => {
        try {
          this.registry.warmExecutionCache();
        } catch {
          // ignore warm-up errors
        }
      });
    }
  }

  #nativeKey(harnessId, nativeSessionId) {
    return `${harnessId}\0${nativeSessionId}`;
  }

  parseSessionId(sessionId, explicitHarness = null) {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("session_id must be a non-empty string.");
    }

    const sepIdx = sessionId.indexOf(":");
    if (sepIdx > 0) {
      const prefix = sessionId.slice(0, sepIdx);
      const rest = sessionId.slice(sepIdx + 1);
      if (rest && this.registry.has(prefix)) {
        if (explicitHarness && explicitHarness !== prefix) {
          throw new Error(
            `Conflicting harness "${explicitHarness}" vs session_id prefix "${prefix}".`,
          );
        }
        return {
          harnessId: prefix,
          nativeSessionId: rest,
          compositeSessionId: sessionId,
        };
      }
    }

    if (explicitHarness) {
      return {
        harnessId: explicitHarness,
        nativeSessionId: sessionId,
        compositeSessionId: formatCompositeSessionId(explicitHarness, sessionId),
      };
    }

    // Fallback: match against currently active native session IDs if unambiguous
    const matches = [];
    for (const session of this.sessions.values()) {
      if (session.nativeSessionId === sessionId) {
        matches.push(session);
      }
    }
    if (matches.length === 1) {
      return {
        harnessId: matches[0].harnessId,
        nativeSessionId: matches[0].nativeSessionId,
        compositeSessionId: matches[0].sessionId,
      };
    }

    return {
      harnessId: null,
      nativeSessionId: sessionId,
      compositeSessionId: sessionId,
    };
  }

  #getOrCreateConnection(harnessId) {
    const entry = this.registry.get(harnessId);
    if (!entry) {
      const available = this.registry.listAll().map((h) => h.id).join(", ");
      throw new Error(`Unknown ACP harness "${harnessId}". Configured harnesses: ${available}`);
    }
    if (!entry.enabled) {
      throw new Error(
        `ACP harness "${harnessId}" is disabled in configuration (${this.registry.configPath}).`,
      );
    }

    const existing = this.connections.get(harnessId);
    if (existing) {
      return existing;
    }

    const execution = this.registry.resolveExecution(entry);
    if (!execution.runnable) {
      const hint = execution.installHint ? ` Hint: ${execution.installHint}` : "";
      throw new Error(
        `ACP harness "${harnessId}" is not installed or runnable.${hint}`,
      );
    }

    const conn = new AcpConnection({
      harnessConfig: entry,
      execution,
      initTimeoutMs: this.initTimeoutMs,
      callbacks: {
        getSessionContext: (hid, nativeSessionId) =>
          this.#getClientCapabilityContext(hid, nativeSessionId),
        onSessionUpdate: (hid, params) => this.#handleSessionUpdate(hid, params),
        onPermissionRequest: (hid, params) => this.#handlePermissionRequest(hid, params),
        onElicitation: (hid, params) => this.#handleElicitation(hid, params),
        onDisconnect: (hid, err) => this.#handleDisconnect(hid, err),
      },
    });

    this.connections.set(harnessId, conn);
    return conn;
  }

  #findSessionByNative(harnessId, nativeSessionId) {
    const compositeId = this.nativeIndex.get(this.#nativeKey(harnessId, nativeSessionId));
    return compositeId ? this.sessions.get(compositeId) ?? null : null;
  }

  #getClientCapabilityContext(harnessId, nativeSessionId) {
    const session = this.#findSessionByNative(harnessId, nativeSessionId);
    if (!session) return null;
    const turn = session.activeTurn;
    const policy = turn?.approvalPolicy ?? session.approvalPolicy ?? "read_only";
    return {
      session,
      policy,
      allowedRoots: [session.cwd, ...(session.additionalDirectories ?? [])],
      recordDenied: (item) => {
        if (turn) {
          turn.deniedPermissions.push({
            harness: harnessId,
            ...item,
          });
        }
      },
    };
  }

  #handleDisconnect(harnessId, error) {
    const reason = error?.message || `ACP harness "${harnessId}" disconnected.`;
    for (const [compositeId, session] of Array.from(this.sessions.entries())) {
      if (session.harnessId !== harnessId) continue;
      if (session.activeTurn) {
        session.activeTurn.abortError = error;
      }
      this.taskManager.markSessionClosed(compositeId, {
        reason,
        markRunningAsFailed: true,
      });
      this.nativeIndex.delete(this.#nativeKey(harnessId, session.nativeSessionId));
      this.sessions.delete(compositeId);
    }
    this.connections.delete(harnessId);
  }

  #handleSessionUpdate(harnessId, params) {
    const session = this.#findSessionByNative(harnessId, params.sessionId);
    const update = params.update;
    if (!session || !update) return;

    const turn = session.activeTurn;

    if (update.sessionUpdate === "current_mode_update" && update.currentModeId) {
      session.mode = update.currentModeId;
      if (turn?.taskId) {
        this.taskManager.updateSessionMeta(turn.taskId, { mode: session.mode });
      }
    } else if (
      update.sessionUpdate === "config_option_update" &&
      Array.isArray(update.configOptions)
    ) {
      session.configOptions = update.configOptions;
      const modelOpt = update.configOptions.find(
        (opt) => opt.id === "model" || opt.category === "model",
      );
      if (modelOpt && "currentValue" in modelOpt) {
        session.model = modelOpt.currentValue;
        if (turn?.taskId) {
          this.taskManager.updateSessionMeta(turn.taskId, { model: session.model });
        }
      }
    }

    if (!turn) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractTextFromContent(update.content);
        if (text) {
          turn.textChunks.push(text);
          if (turn.taskId) {
            this.taskManager.appendMessageChunk(turn.taskId, turn.turnIndex, text);
          }
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = extractTextFromContent(update.content);
        if (text) {
          turn.thoughtChunks.push(text);
          if (turn.taskId) {
            this.taskManager.appendThoughtChunk(turn.taskId, turn.turnIndex, text);
          }
        }
        break;
      }
      case "tool_call": {
        const existing = turn.toolCalls.get(update.toolCallId) ?? {};
        const meta = extractToolMeta(update, existing);
        const status = update.status ?? existing.status ?? "pending";
        turn.toolCalls.set(update.toolCallId, {
          ...existing,
          ...meta,
          status,
        });
        if (turn.taskId) {
          this.taskManager.upsertToolCall(turn.taskId, turn.turnIndex, meta, status);
        }
        break;
      }
      case "tool_call_update": {
        const existing = turn.toolCalls.get(update.toolCallId) ?? {
          toolCallId: update.toolCallId,
        };
        const meta = extractToolMeta(update, existing);
        const status = update.status ?? existing.status ?? "pending";
        turn.toolCalls.set(update.toolCallId, {
          ...existing,
          ...meta,
          status,
        });
        if (turn.taskId) {
          this.taskManager.upsertToolCall(turn.taskId, turn.turnIndex, meta, status);
        }
        break;
      }
      case "plan": {
        if (Array.isArray(update.entries)) {
          turn.plan = update.entries;
          if (turn.taskId) {
            this.taskManager.updatePlan(turn.taskId, turn.turnIndex, update.entries);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async #handlePermissionRequest(harnessId, params) {
    const session = this.#findSessionByNative(harnessId, params.sessionId);
    const turn = session?.activeTurn;
    const policy = turn?.approvalPolicy ?? session?.approvalPolicy ?? "read_only";

    const tc = params.toolCall ?? {};
    const tracked = turn?.toolCalls.get(tc.toolCallId) ?? {};
    const toolMeta = extractToolMeta(tc, tracked);

    if (shouldPromptInteractively(policy, toolMeta) && turn?.taskId) {
      const interactiveRes = await this.taskManager.requestInteractiveApproval({
        taskId: turn.taskId,
        turnIndex: turn.turnIndex,
        harness: harnessId,
        toolMeta,
        options: params.options ?? [],
      });

      if (interactiveRes.approved && interactiveRes.escalateToPolicy) {
        turn.approvalPolicy = interactiveRes.escalateToPolicy;
        this.taskManager.updateTurnPolicy(
          turn.taskId,
          turn.turnIndex,
          interactiveRes.escalateToPolicy,
        );
      }

      if (!interactiveRes.approved && !interactiveRes.cancelled && turn) {
        const deniedItem = {
          harness: harnessId,
          toolName: toolMeta.toolName,
          kind: toolMeta.kind,
          title: toolMeta.title,
          locations: (toolMeta.locations ?? []).map((loc) => loc.path).filter(Boolean),
          inputSummary: summarizeInput(toolMeta.rawInput),
          policy,
          reason: interactiveRes.timedOut ? "approval_timeout" : "rejected_by_user",
        };
        turn.deniedPermissions.push(deniedItem);
        this.taskManager.recordDeniedPermission(turn.taskId, turn.turnIndex, deniedItem);
      }

      return { outcome: interactiveRes.outcome };
    }

    const decision = decideApprovalOption(policy, toolMeta, params.options ?? []);
    if (!decision.approved && turn) {
      const deniedItem = {
        harness: harnessId,
        toolName: toolMeta.toolName,
        kind: toolMeta.kind,
        title: toolMeta.title,
        locations: (toolMeta.locations ?? []).map((loc) => loc.path).filter(Boolean),
        inputSummary: summarizeInput(toolMeta.rawInput),
        policy,
      };
      turn.deniedPermissions.push(deniedItem);
      if (turn.taskId) {
        this.taskManager.recordDeniedPermission(turn.taskId, turn.turnIndex, deniedItem);
      }
    }
    return { outcome: decision.outcome };
  }

  #handleElicitation(harnessId, params) {
    const session = this.#findSessionByNative(harnessId, params.sessionId);
    if (session?.activeTurn) {
      const item = {
        harness: harnessId,
        message: params.message ?? "",
        mode: params.mode ?? "form",
      };
      session.activeTurn.elicitations.push(item);
      if (session.activeTurn.taskId) {
        this.taskManager.recordElicitation(
          session.activeTurn.taskId,
          session.activeTurn.turnIndex,
          item,
        );
      }
    }
    return { action: "cancel" };
  }

  #normalizeCwd(cwd) {
    if (!cwd || typeof cwd !== "string") {
      throw new Error("cwd is required and must be an absolute directory path.");
    }
    if (!isAbsolute(cwd)) {
      throw new Error(`cwd must be an absolute path, got: ${cwd}`);
    }
    const resolved = resolve(cwd);
    if (!existsSync(resolved)) {
      throw new Error(`cwd does not exist: ${resolved}`);
    }
    return resolved;
  }

  async #applySessionSettings(conn, session, { mode, model, configOptions }) {
    const warnings = [];

    if (mode && mode !== session.mode) {
      try {
        await conn.request(AGENT_METHODS.session_set_mode, {
          sessionId: session.nativeSessionId,
          modeId: mode,
        });
        session.mode = mode;
      } catch (err) {
        warnings.push(`Failed to set mode="${mode}" on ${session.harnessId}: ${err.message}`);
      }
    }

    const mergedConfig = { ...(configOptions ?? {}) };
    if (model && mergedConfig.model === undefined) {
      mergedConfig.model = model;
    }

    for (const [configId, value] of Object.entries(mergedConfig)) {
      if (value === undefined || value === null) continue;
      if (configId === "model" && value === session.model) continue;

      try {
        const res = await conn.request(AGENT_METHODS.session_set_config_option, {
          sessionId: session.nativeSessionId,
          configId,
          value,
        });
        if (configId === "model") {
          session.model = String(value);
        }
        if (Array.isArray(res?.configOptions)) {
          session.configOptions = res.configOptions;
        }
      } catch (err) {
        warnings.push(
          `Failed to set config "${configId}=${value}" on ${session.harnessId}: ${err.message}`,
        );
      }
    }

    return warnings;
  }

  async #withSessionLock(session, fn) {
    const prev = session.lockPromise ?? Promise.resolve();
    let release;
    const current = new Promise((res) => {
      release = res;
    });
    session.lockPromise = prev.then(() => current, () => current);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  recentStderr(harnessId = null) {
    if (harnessId) {
      return this.connections.get(harnessId)?.recentStderr() ?? "";
    }
    const parts = [];
    for (const [id, conn] of this.connections.entries()) {
      const text = conn.recentStderr(8);
      if (text) parts.push(`[${id}]\n${text}`);
    }
    return parts.join("\n\n");
  }

  async listHarnesses({ harness = null, probe = false, forceRefresh = false } = {}) {
    this.registry.reloadIfChanged();
    if (forceRefresh) {
      this.registry.clearExecutionCache();
    }
    const entries = harness
      ? [this.registry.get(harness)].filter(Boolean)
      : this.registry.listAll();

    if (harness && entries.length === 0) {
      throw new Error(`Unknown ACP harness "${harness}".`);
    }

    const results = [];
    for (const entry of entries) {
      const execution = this.registry.resolveExecution(entry, process.env, {
        forceRefresh,
      });
      let conn = this.connections.get(entry.id) ?? null;
      let probeError = null;

      if (probe && entry.enabled && execution.runnable) {
        try {
          conn = this.#getOrCreateConnection(entry.id);
          await conn.ensureConnected();
        } catch (err) {
          probeError = err.message;
        }
      }

      const activeSessions = Array.from(this.sessions.values()).filter(
        (s) => s.harnessId === entry.id,
      );

      results.push({
        id: entry.id,
        displayName: entry.displayName,
        description: entry.description ?? "",
        isBuiltin: Boolean(entry.isBuiltin),
        isDefault: entry.id === this.registry.defaultHarness,
        enabled: entry.enabled,
        installed: execution.installed,
        runnable: execution.runnable,
        resolution: execution.resolution,
        canFallbackToNpx: Boolean(execution.canFallbackToNpx),
        command: execution.displayCommand,
        executable: execution.executable ?? null,
        installHint: execution.installHint,
        defaultMode: entry.defaultMode ?? null,
        defaultApprovalPolicy: entry.defaultApprovalPolicy ?? "read_only",
        clientCapabilities: entry.clientCapabilities,
        connectionStatus: conn ? conn.status : "idle",
        activeSessionCount: activeSessions.length,
        agentInfo: conn?.capabilities?.agentInfo ?? null,
        capabilities: conn?.capabilities
          ? {
              protocolVersion: conn.capabilities.protocolVersion,
              loadSession: conn.capabilities.loadSession,
              listSessions: conn.capabilities.listSessions,
              deleteSession: conn.capabilities.deleteSession,
              closeSession: conn.capabilities.closeSession,
              resumeSession: conn.capabilities.resumeSession,
              additionalDirectories: conn.capabilities.additionalDirectories,
              imagePrompt: conn.capabilities.imagePrompt,
              authMethods: conn.capabilities.authMethods,
            }
          : null,
        probeError: probeError ?? conn?.lastError ?? null,
      });
    }

    return {
      configPath: this.registry.configPath,
      configWarning: this.registry.configLoadWarning,
      defaultHarness: this.registry.defaultHarness,
      harnesses: results,
    };
  }

  async disconnectHarness(harnessId) {
    if (!this.registry.has(harnessId)) {
      throw new Error(`Unknown ACP harness "${harnessId}".`);
    }

    let closedSessionCount = 0;
    for (const [compositeId, session] of Array.from(this.sessions.entries())) {
      if (session.harnessId !== harnessId) continue;
      await this.closeSession(compositeId).catch(() => {});
      closedSessionCount += 1;
    }

    const conn = this.connections.get(harnessId);
    let disconnected = false;
    if (conn) {
      this.connections.delete(harnessId);
      await conn.dispose().catch(() => {});
      disconnected = true;
    }

    return {
      harness: harnessId,
      disconnected,
      closedSessionCount,
    };
  }

  async setHarnessEnabled(harnessId, enabled) {
    if (!this.registry.has(harnessId)) {
      throw new Error(`Unknown ACP harness "${harnessId}".`);
    }
    const nextEnabled = Boolean(enabled);
    await this.registry.setHarnessEnabled(harnessId, nextEnabled);
    if (!nextEnabled) {
      await this.disconnectHarness(harnessId);
    }
    return this.listHarnesses();
  }

  async setDefaultHarness(harnessId) {
    const entry = this.registry.get(harnessId);
    if (!entry) {
      throw new Error(`Unknown ACP harness "${harnessId}".`);
    }
    if (!entry.enabled) {
      throw new Error(
        `Cannot set disabled ACP harness "${harnessId}" as default. Enable it first.`,
      );
    }
    await this.registry.setDefaultHarness(harnessId);
    return this.listHarnesses();
  }

  async newSession({
    harness,
    cwd,
    mode,
    approvalPolicy,
    model,
    configOptions,
    additionalDirectories,
  }) {
    const targetHarness = harness || this.registry.defaultHarness;
    const entry = this.registry.get(targetHarness);
    if (!entry) {
      throw new Error(`Unknown ACP harness "${targetHarness}".`);
    }

    const conn = this.#getOrCreateConnection(targetHarness);
    await conn.ensureConnected();

    const normalizedCwd = this.#normalizeCwd(cwd);
    const normalizedAdditional = additionalDirectories?.map((d) => this.#normalizeCwd(d)) ?? [];
    const warnings = [];

    const request = {
      cwd: normalizedCwd,
      mcpServers: [],
    };
    if (normalizedAdditional.length > 0) {
      if (conn.capabilities?.additionalDirectories) {
        request.additionalDirectories = normalizedAdditional;
      } else {
        warnings.push(
          `Harness "${targetHarness}" did not advertise additionalDirectories capability; ignored additional_directories.`,
        );
      }
    }

    const res = await conn.request(AGENT_METHODS.session_new, request);
    const nativeSessionId = res.sessionId;
    const compositeSessionId = formatCompositeSessionId(targetHarness, nativeSessionId);

    const effectivePolicy = approvalPolicy ?? entry.defaultApprovalPolicy ?? "read_only";
    const effectiveMode = mode ?? entry.defaultMode;

    const session = {
      sessionId: compositeSessionId,
      nativeSessionId,
      harnessId: targetHarness,
      cwd: normalizedCwd,
      additionalDirectories: normalizedAdditional,
      mode: res.modes?.currentModeId ?? null,
      availableModes: res.modes?.availableModes ?? [],
      model:
        res.models?.currentModelId ??
        res.configOptions?.find((o) => o.id === "model" || o.category === "model")
          ?.currentValue ??
        null,
      availableModels: res.models?.availableModels ?? [],
      configOptions: res.configOptions ?? [],
      approvalPolicy: effectivePolicy,
      lockPromise: Promise.resolve(),
      activeTurn: null,
    };

    this.sessions.set(compositeSessionId, session);
    this.nativeIndex.set(this.#nativeKey(targetHarness, nativeSessionId), compositeSessionId);

    const settingWarnings = await this.#applySessionSettings(conn, session, {
      mode: effectiveMode,
      model,
      configOptions,
    });
    warnings.push(...settingWarnings);

    return {
      sessionId: session.sessionId,
      harness: session.harnessId,
      cwd: session.cwd,
      mode: session.mode,
      approvalPolicy: session.approvalPolicy,
      model: session.model,
      availableModes: session.availableModes.map((m) => m.id),
      availableModels: session.availableModels
        .map((m) => m.modelId ?? m.value ?? m.id)
        .filter(Boolean),
      configOptions: session.configOptions.map((o) => ({
        id: o.id,
        name: o.name,
        category: o.category ?? null,
        currentValue: o.currentValue ?? null,
      })),
      capabilities: conn.capabilities
        ? {
            loadSession: conn.capabilities.loadSession,
            listSessions: conn.capabilities.listSessions,
            closeSession: conn.capabilities.closeSession,
          }
        : null,
      warnings,
    };
  }

  async loadSession({
    sessionId,
    harness,
    cwd,
    mode,
    approvalPolicy,
    model,
    configOptions,
  }) {
    const parsed = this.parseSessionId(sessionId, harness);
    if (!parsed.harnessId) {
      throw new Error(
        `Cannot determine harness for session_id="${sessionId}". Pass the "harness" parameter or use a prefixed "<harness>:<sessionId>" ID.`,
      );
    }

    const entry = this.registry.get(parsed.harnessId);
    const conn = this.#getOrCreateConnection(parsed.harnessId);
    await conn.ensureConnected();

    if (!conn.capabilities?.loadSession) {
      throw new Error(
        `Harness "${parsed.harnessId}" does not advertise ACP "loadSession" capability. Use acp_new_session instead.`,
      );
    }

    const normalizedCwd = this.#normalizeCwd(cwd);
    const res = await conn.request(AGENT_METHODS.session_load, {
      sessionId: parsed.nativeSessionId,
      cwd: normalizedCwd,
      mcpServers: [],
    });

    const compositeSessionId = formatCompositeSessionId(
      parsed.harnessId,
      parsed.nativeSessionId,
    );
    const effectivePolicy = approvalPolicy ?? entry?.defaultApprovalPolicy ?? "read_only";

    const session = {
      sessionId: compositeSessionId,
      nativeSessionId: parsed.nativeSessionId,
      harnessId: parsed.harnessId,
      cwd: normalizedCwd,
      additionalDirectories: [],
      mode: res?.modes?.currentModeId ?? null,
      availableModes: res?.modes?.availableModes ?? [],
      model:
        res?.models?.currentModelId ??
        res?.configOptions?.find((o) => o.id === "model" || o.category === "model")
          ?.currentValue ??
        null,
      availableModels: res?.models?.availableModels ?? [],
      configOptions: res?.configOptions ?? [],
      approvalPolicy: effectivePolicy,
      lockPromise: Promise.resolve(),
      activeTurn: null,
    };

    this.sessions.set(compositeSessionId, session);
    this.nativeIndex.set(
      this.#nativeKey(parsed.harnessId, parsed.nativeSessionId),
      compositeSessionId,
    );

    const warnings = await this.#applySessionSettings(conn, session, {
      mode,
      model,
      configOptions,
    });

    return {
      sessionId: session.sessionId,
      harness: session.harnessId,
      cwd: session.cwd,
      mode: session.mode,
      approvalPolicy: session.approvalPolicy,
      model: session.model,
      warnings,
    };
  }

  async #executeTurnOnLockedSession(
    session,
    {
      task,
      turnRecord,
      message,
      mode,
      approvalPolicy,
      model,
      configOptions,
      timeoutSeconds,
      initialWarnings = [],
    },
  ) {
    const entry = this.registry.get(session.harnessId);
    const effectiveTimeout = timeoutSeconds ?? entry?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const effectivePolicy = approvalPolicy ?? session.approvalPolicy;

    let warnings = [...initialWarnings];
    let timedOut = false;
    let timer = null;
    const turn = {
      taskId: task?.taskId ?? null,
      turnIndex: turnRecord?.turnIndex ?? 1,
      approvalPolicy: effectivePolicy,
      textChunks: [],
      thoughtChunks: [],
      toolCalls: new Map(),
      deniedPermissions: [],
      elicitations: [],
      plan: null,
      abortError: null,
    };
    session.activeTurn = turn;

    try {
      // H1 fix: keep connection setup and session settings inside try/finally so
      // failures always transition task/turn out of "running".
      const conn = this.#getOrCreateConnection(session.harnessId);
      await conn.ensureConnected();

      const settingWarnings = await this.#applySessionSettings(conn, session, {
        mode,
        model,
        configOptions,
      });
      warnings = [...initialWarnings, ...settingWarnings];

      if (task) {
        this.taskManager.updateSessionMeta(task.taskId, {
          mode: session.mode,
          model: session.model,
        });
      }

      const controller = new AbortController();
      timer = setTimeout(() => {
        timedOut = true;
        if (task) {
          this.taskManager.cancelPendingApprovalsForTask(
            task.taskId,
            `Turn timed out after ${effectiveTimeout}s.`,
          );
        }
        controller.abort();
        conn
          .notify(AGENT_METHODS.session_cancel, { sessionId: session.nativeSessionId })
          .catch(() => {});
      }, effectiveTimeout * 1000);

      const promptRes = await conn.request(
        AGENT_METHODS.session_prompt,
        {
          sessionId: session.nativeSessionId,
          prompt: [{ type: "text", text: message }],
        },
        { signal: controller.signal },
      );

      const stopReason = timedOut ? "timeout" : promptRes.stopReason;
      const finalWarnings = timedOut
        ? [
            ...warnings,
            `Turn timed out after ${effectiveTimeout}s and session/cancel was sent.`,
          ]
        : warnings;

      const finalStatus =
        timedOut || stopReason === "cancelled" ? "cancelled" : "completed";

      if (task && turnRecord) {
        this.taskManager.finishTurn(task.taskId, turnRecord.turnIndex, {
          status: finalStatus,
          stopReason,
          warnings: finalWarnings,
          mode: session.mode,
          model: session.model,
        });
      }

      return {
        taskId: task?.taskId ?? null,
        sessionId: session.sessionId,
        harness: session.harnessId,
        cwd: session.cwd,
        mode: session.mode,
        approvalPolicy: effectivePolicy,
        model: session.model,
        stopReason,
        usage: promptRes.usage ?? null,
        text: turn.textChunks.join(""),
        toolCalls: Array.from(turn.toolCalls.values()).map((tc) => ({
          toolName: tc.toolName,
          kind: tc.kind,
          title: tc.title,
          status: tc.status,
        })),
        deniedPermissions: turn.deniedPermissions,
        elicitations: turn.elicitations,
        plan: turn.plan,
        warnings: finalWarnings,
      };
    } catch (err) {
      if (timedOut) {
        const finalWarnings = [
          ...warnings,
          `Turn timed out after ${effectiveTimeout}s and session/cancel was sent.`,
        ];
        if (task && turnRecord) {
          this.taskManager.finishTurn(task.taskId, turnRecord.turnIndex, {
            status: "cancelled",
            stopReason: "timeout",
            warnings: finalWarnings,
            mode: session.mode,
            model: session.model,
          });
        }
        return {
          taskId: task?.taskId ?? null,
          sessionId: session.sessionId,
          harness: session.harnessId,
          cwd: session.cwd,
          mode: session.mode,
          approvalPolicy: effectivePolicy,
          model: session.model,
          stopReason: "timeout",
          text: turn.textChunks.join(""),
          toolCalls: Array.from(turn.toolCalls.values()).map((tc) => ({
            toolName: tc.toolName,
            kind: tc.kind,
            title: tc.title,
            status: tc.status,
          })),
          deniedPermissions: turn.deniedPermissions,
          elicitations: turn.elicitations,
          plan: turn.plan,
          warnings: finalWarnings,
        };
      }
      const effectiveErr = turn.abortError ?? err;
      if (task && turnRecord) {
        this.taskManager.finishTurn(task.taskId, turnRecord.turnIndex, {
          status: "failed",
          stopReason: "error",
          warnings,
          error: effectiveErr.message,
          mode: session.mode,
          model: session.model,
        });
      }
      throw effectiveErr;
    } finally {
      if (timer) clearTimeout(timer);
      if (task) {
        this.taskManager.cancelPendingApprovalsForTask(task.taskId, "Turn ended.");
      }
      session.activeTurn = null;
      session.pendingDispatch = false;
    }
  }

  async prompt({
    sessionId,
    message,
    mode,
    approvalPolicy,
    model,
    configOptions,
    timeoutSeconds,
  }) {
    const parsed = this.parseSessionId(sessionId);
    const session = this.sessions.get(parsed.compositeSessionId);
    if (!session) {
      throw new Error(
        `Session not found in active ACP hub: ${sessionId}. Use acp_new_session or acp_load_session first.`,
      );
    }

    const entry = this.registry.get(session.harnessId);
    const effectivePolicy = approvalPolicy ?? session.approvalPolicy;

    return this.#withSessionLock(session, async () => {
      const task = this.taskManager.getOrCreateTaskForSession({
        sessionId: session.sessionId,
        harness: session.harnessId,
        harnessDisplayName: entry?.displayName ?? session.harnessId,
        cwd: session.cwd,
        prompt: message,
        mode: mode ?? session.mode,
        model: model ?? session.model,
        approvalPolicy: effectivePolicy,
      });
      const turnRecord = this.taskManager.startTurn(task.taskId, {
        prompt: message,
        source: "model",
        approvalPolicy: effectivePolicy,
        mode: mode ?? session.mode,
        model: model ?? session.model,
      });

      return this.#executeTurnOnLockedSession(session, {
        task,
        turnRecord,
        message,
        mode,
        approvalPolicy: effectivePolicy,
        model,
        configOptions,
        timeoutSeconds,
      });
    });
  }

  async dispatchTask({
    harness,
    cwd,
    sessionId,
    taskId,
    title,
    prompt,
    mode,
    approvalPolicy,
    model,
    configOptions,
    additionalDirectories,
    timeoutSeconds,
    source = "model",
  }) {
    if (!prompt || !String(prompt).trim()) {
      throw new Error("prompt must be a non-empty string when dispatching a task.");
    }

    let targetSessionId = sessionId ?? null;
    if (!targetSessionId && taskId) {
      const existingTask = this.taskManager.getTask(taskId);
      if (!existingTask) {
        throw new Error(`Unknown ACP task "${taskId}".`);
      }
      if (existingTask.sessionClosed) {
        if (existingTask.restoredFromDisk && existingTask.sessionId && existingTask.cwd) {
          try {
            const loaded = await this.loadSession({
              sessionId: existingTask.sessionId,
              harness: existingTask.harness,
              cwd: existingTask.cwd,
              mode: mode ?? existingTask.mode ?? undefined,
              approvalPolicy: approvalPolicy ?? existingTask.approvalPolicy,
              model: model ?? existingTask.model ?? undefined,
            });
            this.taskManager.markSessionReopened(taskId, {
              sessionId: loaded.sessionId,
              mode: loaded.mode,
              model: loaded.model,
            });
          } catch (err) {
            throw new Error(
              `历史任务会话无法自动恢复（${err.message}）。请派发新任务。`,
            );
          }
        } else {
          throw new Error(
            `Session for task "${taskId}" has been closed. Dispatch a new task instead.`,
          );
        }
      }
      targetSessionId = existingTask.sessionId;
    }

    let session = null;
    let initialWarnings = [];
    const effectivePolicy = approvalPolicy ?? "interactive";

    if (targetSessionId) {
      const parsed = this.parseSessionId(targetSessionId);
      session = this.sessions.get(parsed.compositeSessionId);
      if (!session) {
        throw new Error(
          `Session not found in active ACP hub: ${targetSessionId}. Dispatch a new task with cwd instead.`,
        );
      }
      if (session.activeTurn || session.pendingDispatch) {
        throw new Error(
          `Session "${session.sessionId}" is currently busy running another turn. Wait for it to finish or cancel it first.`,
        );
      }
      // Atomic reservation before async lock acquisition (H3 fix)
      session.pendingDispatch = true;
    } else {
      if (!cwd) {
        throw new Error(
          "cwd (absolute path) is required when dispatching a task without an existing session_id or task_id.",
        );
      }
      const created = await this.newSession({
        harness,
        cwd,
        mode,
        approvalPolicy: effectivePolicy,
        model,
        configOptions,
        additionalDirectories,
      });
      initialWarnings = created.warnings ?? [];
      session = this.sessions.get(created.sessionId);
      session.pendingDispatch = true;
    }

    const entry = this.registry.get(session.harnessId);
    const turnPolicy = approvalPolicy ?? (targetSessionId ? session.approvalPolicy : effectivePolicy);
    const task = this.taskManager.getOrCreateTaskForSession({
      sessionId: session.sessionId,
      harness: session.harnessId,
      harnessDisplayName: entry?.displayName ?? session.harnessId,
      cwd: session.cwd,
      title,
      prompt,
      mode: mode ?? session.mode,
      model: model ?? session.model,
      approvalPolicy: turnPolicy,
    });
    const turnRecord = this.taskManager.startTurn(task.taskId, {
      prompt,
      source,
      approvalPolicy: turnPolicy,
      mode: mode ?? session.mode,
      model: model ?? session.model,
    });

    // Run turn asynchronously in the background without blocking the MCP tool response.
    void this.#withSessionLock(session, () =>
      this.#executeTurnOnLockedSession(session, {
        task,
        turnRecord,
        message: prompt,
        mode,
        approvalPolicy: turnPolicy,
        model,
        configOptions,
        timeoutSeconds,
        initialWarnings,
      }),
    ).catch((err) => {
      session.pendingDispatch = false;
      this.taskManager.finishTurn(task.taskId, turnRecord.turnIndex, {
        status: "failed",
        stopReason: "error",
        error: err?.message ?? String(err),
        mode: session.mode,
        model: session.model,
      });
    });

    return {
      taskId: task.taskId,
      sessionId: session.sessionId,
      harness: session.harnessId,
      cwd: session.cwd,
      title: task.title,
      status: task.status,
      mode: session.mode,
      model: session.model,
      approvalPolicy: turnPolicy,
      warnings: initialWarnings,
      workspace: this.getWorkspaceSnapshot({ activeTaskId: task.taskId }),
    };
  }

  async followUpTask({ taskId, message, approvalPolicy, mode, model, timeoutSeconds }) {
    if (!taskId) {
      throw new Error("task_id is required.");
    }
    return this.dispatchTask({
      taskId,
      prompt: message,
      approvalPolicy,
      mode,
      model,
      timeoutSeconds,
      source: "ui",
    });
  }

  async waitTask(taskId, { timeoutSeconds = 120, returnOnApproval = false } = {}) {
    const bounded = Math.min(Math.max(1, timeoutSeconds ?? 120), 150);
    return this.taskManager.waitForTask(taskId, {
      timeoutSeconds: bounded,
      returnOnApproval,
    });
  }

  async cancelTask(taskId) {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown ACP task "${taskId}".`);
    }
    this.taskManager.cancelPendingApprovalsForTask(taskId, "Task cancelled by user.");
    if (!task.sessionClosed && this.sessions.has(task.sessionId)) {
      await this.cancel(task.sessionId).catch(() => {});
    }
    return {
      cancelled: true,
      taskId,
      sessionId: task.sessionId,
      workspace: this.getWorkspaceSnapshot({ activeTaskId: taskId }),
    };
  }

  async closeTaskSession(taskId) {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown ACP task "${taskId}".`);
    }
    this.taskManager.cancelPendingApprovalsForTask(taskId, "Session closed by user.");
    if (!task.sessionClosed && this.sessions.has(task.sessionId)) {
      await this.closeSession(task.sessionId);
    } else {
      this.taskManager.markSessionClosed(task.sessionId, {
        reason: "Session closed by user.",
        markRunningAsFailed: false,
      });
    }
    return {
      closed: true,
      taskId,
      sessionId: task.sessionId,
      workspace: this.getWorkspaceSnapshot({ activeTaskId: taskId }),
    };
  }

  resolveApproval(approvalId, decision) {
    const res = this.taskManager.resolveApproval(approvalId, decision);
    return {
      ...res,
      workspace: this.getWorkspaceSnapshot({ activeTaskId: res.taskId }),
    };
  }

  getWorkspaceSnapshot({ activeTaskId = null, sessionId = null } = {}) {
    return this.taskManager.getWorkspaceSnapshot({ activeTaskId, sessionId });
  }

  pollTask(taskId = null, { sinceSeq = 0 } = {}) {
    return this.taskManager.pollTask(taskId, { sinceSeq });
  }

  async cancel(sessionId) {
    const parsed = this.parseSessionId(sessionId);
    const session = this.sessions.get(parsed.compositeSessionId);
    if (!session) {
      throw new Error(`Session not found in active ACP hub: ${sessionId}`);
    }
    const conn = this.connections.get(session.harnessId);
    if (!conn || !conn.isAlive()) {
      throw new Error(`Harness "${session.harnessId}" is not currently connected.`);
    }
    await conn.notify(AGENT_METHODS.session_cancel, {
      sessionId: session.nativeSessionId,
    });
    return {
      cancelled: true,
      sessionId: session.sessionId,
      harness: session.harnessId,
    };
  }

  async closeSession(sessionId) {
    const parsed = this.parseSessionId(sessionId);
    const session = this.sessions.get(parsed.compositeSessionId);
    if (!session) {
      this.taskManager.markSessionClosed(parsed.compositeSessionId, {
        reason: "Session closed.",
        markRunningAsFailed: false,
      });
      return {
        closed: false,
        sessionId: parsed.compositeSessionId,
        harness: parsed.harnessId,
      };
    }

    this.taskManager.markSessionClosed(session.sessionId, {
      reason: "Session closed.",
      markRunningAsFailed: false,
    });

    const conn = this.connections.get(session.harnessId);
    if (conn) {
      conn.releaseSessionResources(session.nativeSessionId);
      if (conn.isAlive()) {
        await conn
          .request(AGENT_METHODS.session_close, {
            sessionId: session.nativeSessionId,
          })
          .catch(() => {});
      }
    }

    this.nativeIndex.delete(this.#nativeKey(session.harnessId, session.nativeSessionId));
    this.sessions.delete(session.sessionId);

    return {
      closed: true,
      sessionId: session.sessionId,
      harness: session.harnessId,
    };
  }

  async listSessions({ harness = null, cwd = null, includeHistory = false } = {}) {
    const normalizedCwd = cwd ? this.#normalizeCwd(cwd) : null;
    const active = Array.from(this.sessions.values())
      .filter((s) => (!harness || s.harnessId === harness) && (!normalizedCwd || s.cwd === normalizedCwd))
      .map((s) => ({
        sessionId: s.sessionId,
        harness: s.harnessId,
        cwd: s.cwd,
        mode: s.mode,
        approvalPolicy: s.approvalPolicy,
        model: s.model,
        busy: Boolean(s.activeTurn),
      }));

    const history = [];
    const warnings = [];

    if (includeHistory) {
      const targetHarnessIds = harness
        ? [harness]
        : Array.from(this.connections.keys());

      if (targetHarnessIds.length === 0) {
        warnings.push(
          "No active harness connections to query history from. Pass the \"harness\" parameter to connect and query a specific harness.",
        );
      }

      for (const hid of targetHarnessIds) {
        try {
          const conn = this.#getOrCreateConnection(hid);
          await conn.ensureConnected();
          if (!conn.capabilities?.listSessions) {
            warnings.push(
              `Harness "${hid}" does not advertise ACP "session/list" capability; returning active in-memory sessions only.`,
            );
            continue;
          }
          const params = normalizedCwd ? { cwd: normalizedCwd } : {};
          const res = await conn.request(AGENT_METHODS.session_list, params);
          for (const item of res?.sessions ?? []) {
            history.push({
              ...item,
              harness: hid,
              nativeSessionId: item.sessionId,
              sessionId: formatCompositeSessionId(hid, item.sessionId),
            });
          }
        } catch (err) {
          warnings.push(`Failed to list history for harness "${hid}": ${err.message}`);
        }
      }
    }

    return { active, history, warnings };
  }

  async dispose() {
    this.taskManager.dispose();
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId).catch(() => {});
    }
    for (const conn of this.connections.values()) {
      await conn.dispose().catch(() => {});
    }
    this.connections.clear();
    this.sessions.clear();
    this.nativeIndex.clear();
  }
}
