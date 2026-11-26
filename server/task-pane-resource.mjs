import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { APPROVAL_POLICIES } from "./permission-policy.mjs";
import { TASK_PANE_HTML } from "./generated/task-pane-html.mjs";

export const TASK_PANE_RESOURCE_URI = "ui://acp-hub/task-pane.html";
export const TASK_PANE_MIME_TYPE = "text/html;profile=mcp-app";

const TASK_PANE_ENTRY_META = Object.freeze({
  ui: {
    resourceUri: TASK_PANE_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  "com.google.antigravity/ui": {
    entrypoints: [{ type: "aux_pane", title: "ACP 任务台" }],
  },
});

const APP_ONLY_META = Object.freeze({
  ui: {
    visibility: ["app"],
  },
});

const approvalPolicySchema = z
  .enum(APPROVAL_POLICIES)
  .optional()
  .describe(
    "Bridge approval policy: interactive (default for dispatched tasks; auto-allows read-only tools and prompts in the right-hand ACP Task Pane for edits/shell/deletes), read_only, accept_edits, allow_all, or reject_all.",
  );

const configOptionsSchema = z
  .record(z.string(), z.union([z.string(), z.boolean()]))
  .optional()
  .describe("Optional ACP session config options passed via session/set_config_option.");

export function loadTaskPaneHtml() {
  const overridePath = process.env.ACP_HUB_TASK_PANE_HTML;
  if (overridePath && existsSync(overridePath)) {
    return readFileSync(overridePath, "utf8");
  }
  return TASK_PANE_HTML;
}

function uiToolError(hub, err, harnessId = null) {
  const stderr = hub.recentStderr(harnessId);
  const detail = stderr ? `${err.message}\n\nRecent ACP stderr:\n${stderr}` : err.message;
  return {
    isError: true,
    content: [{ type: "text", text: detail }],
  };
}

function formatWorkspaceSummary(snapshot) {
  const lines = [
    `ACP 任务台 (${snapshot.totalTasks} tasks | ${snapshot.runningCount} running | ${snapshot.waitingApprovalCount} waiting_approval)`,
  ];
  if (snapshot.activeTask) {
    const t = snapshot.activeTask;
    lines.push(
      `activeTask=${t.taskId} | sessionId=${t.sessionId} | harness=${t.harness} | status=${t.status} | title="${t.title}"`,
    );
  } else {
    lines.push("No active ACP tasks yet. Dispatch a task with acp_dispatch_task.");
  }
  return lines.join("\n");
}

function formatDispatchedSummary(result) {
  const lines = [
    `[ACP Task Dispatched] taskId=${result.taskId} | sessionId=${result.sessionId} | harness=${result.harness} | status=${result.status} | approvalPolicy=${result.approvalPolicy}`,
    `title: ${result.title}`,
    `cwd: ${result.cwd}`,
  ];
  if (result.model) lines.push(`model: ${result.model}`);
  if (result.warnings?.length) {
    lines.push(`warnings:\n- ${result.warnings.join("\n- ")}`);
  }
  lines.push(
    "The right-hand ACP Task Pane has been updated with live streaming progress. Use acp_wait_task(task_id) in a background subagent to await completion without blocking the main conversation.",
  );
  return lines.join("\n");
}

function formatWaitResult(waitRes) {
  const task = waitRes.task;
  const lastTurn = task.turns[task.turns.length - 1] ?? null;
  const header = [
    `[ACP Task:${task.harness}]`,
    `taskId=${task.taskId}`,
    `sessionId=${task.sessionId}`,
    `status=${task.status}`,
    `stopReason=${task.stopReason ?? "none"}`,
    waitRes.timedOut ? "wait=timed_out" : "wait=settled",
  ].join(" | ");

  const lines = [header];
  if (waitRes.timedOut && (task.status === "running" || task.status === "waiting_approval")) {
    lines.push(
      "[Notice] 任务仍在后台运行（尚未结束），请立即再次调用 acp_wait_task 继续守候直至进入终态。",
    );
  }
  if (task.model) lines.push(`model: ${task.model}`);
  if (task.error) lines.push(`error: ${task.error}`);
  if (task.pendingApprovals?.length) {
    lines.push("pending_approvals (waiting for user action in the right-hand ACP Task Pane):");
    for (const a of task.pendingApprovals) {
      lines.push(
        `- approvalId=${a.approvalId} tool=${a.toolName} kind=${a.kind || "unknown"} title="${a.title}" input=${a.inputSummary}`,
      );
    }
  }
  if (task.files?.length) {
    lines.push(
      `files_touched (${task.files.length}):\n${task.files
        .map((f) => `- [${f.actions.join(",")}] ${f.displayPath}`)
        .join("\n")}`,
    );
  }
  if (lastTurn?.warnings?.length) {
    lines.push(`warnings:\n- ${lastTurn.warnings.join("\n- ")}`);
  }
  if (lastTurn?.deniedPermissions?.length) {
    lines.push("denied_permissions:");
    for (const item of lastTurn.deniedPermissions) {
      lines.push(
        `- tool=${item.toolName} kind=${item.kind || "unknown"} title="${item.title}" reason=${item.reason ?? item.policy}`,
      );
    }
  }
  if (lastTurn?.elicitations?.length) {
    lines.push("agent_questions:");
    for (const q of lastTurn.elicitations) {
      lines.push(`- ${q.message}`);
    }
  }
  if (lastTurn?.toolCalls?.length) {
    lines.push(
      `tool_calls (${lastTurn.toolCalls.length}): ${lastTurn.toolCalls
        .map((tc) => `${tc.toolName}[${tc.status}]`)
        .join(", ")}`,
    );
  }
  if (lastTurn?.plan?.length) {
    lines.push(
      `plan:\n${lastTurn.plan.map((p) => `- [${p.status ?? "pending"}] ${p.content}`).join("\n")}`,
    );
  }
  if (lastTurn?.text) {
    lines.push("", lastTurn.text);
  } else {
    lines.push("", "(No assistant text produced yet)");
  }
  return lines.join("\n");
}

export function registerTaskPaneApp(server, hub) {
  server.registerResource(
    "acp-hub-task-pane",
    TASK_PANE_RESOURCE_URI,
    {
      title: "ACP 任务台",
      description:
        "Interactive right-hand side pane (aux_pane) for live ACP task streaming, file preview, interactive permission approvals, follow-ups, and handoff back to the main conversation.",
      mimeType: TASK_PANE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: TASK_PANE_MIME_TYPE,
          text: loadTaskPaneHtml(),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  // Single aux_pane entrypoint tool:
  // - Called with {} (e.g. from the side pane "+" menu) or task_id only -> opens/focuses ACP Task Pane.
  // - Called with prompt -> dispatches an async background ACP task and auto-opens/updates ACP Task Pane.
  server.registerTool(
    "acp_dispatch_task",
    {
      title: "ACP 任务台",
      description:
        "Dispatch an asynchronous ACP task to a configured harness (e.g. Claude Code) and automatically open/update the right-hand ACP Task Pane for live streaming preview, file inspection, interactive permission approvals, and direct follow-ups. When called with empty arguments ({}) or only task_id/session_id, opens or focuses the ACP Task Pane without starting a new turn.",
      inputSchema: {
        prompt: z
          .string()
          .optional()
          .describe(
            "Task prompt to run asynchronously in the background. Omit to simply open or focus the right-hand ACP Task Pane.",
          ),
        harness: z
          .string()
          .optional()
          .describe("Target ACP harness ID (defaults to defaultHarness in acp-harnesses.json)."),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory path (required when starting a new session task)."),
        session_id: z
          .string()
          .optional()
          .describe("Optional existing composite session_id (<harness>:<nativeId>) to reuse."),
        task_id: z
          .string()
          .optional()
          .describe(
            "Optional existing task_id to focus in the pane, or to send a follow-up turn when combined with prompt.",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional concise task title shown in the right-hand ACP Task Pane header."),
        mode: z.string().optional().describe("Optional ACP session mode id."),
        approval_policy: approvalPolicySchema,
        model: z.string().optional().describe("Optional model ID override."),
        config_options: configOptionsSchema,
        additional_directories: z
          .array(z.string())
          .optional()
          .describe("Optional additional absolute directory paths."),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Turn timeout in seconds (default 300)."),
      },
      _meta: TASK_PANE_ENTRY_META,
    },
    async (args = {}) => {
      try {
        if (!args.prompt || !args.prompt.trim()) {
          const snapshot = hub.getWorkspaceSnapshot({
            activeTaskId: args.task_id ?? null,
            sessionId: args.session_id ?? null,
          });
          return {
            content: [{ type: "text", text: formatWorkspaceSummary(snapshot) }],
            structuredContent: snapshot,
          };
        }

        const dispatched = await hub.dispatchTask({
          harness: args.harness,
          cwd: args.cwd,
          sessionId: args.session_id,
          taskId: args.task_id,
          title: args.title,
          prompt: args.prompt,
          mode: args.mode,
          approvalPolicy: args.approval_policy,
          model: args.model,
          configOptions: args.config_options,
          additionalDirectories: args.additional_directories,
          timeoutSeconds: args.timeout_seconds,
          source: "model",
        });

        return {
          content: [{ type: "text", text: formatDispatchedSummary(dispatched) }],
          structuredContent: dispatched.workspace,
        };
      } catch (err) {
        return uiToolError(hub, err, args.harness ?? null);
      }
    },
  );

  // Model-callable waiter tool for background subagents to await async ACP tasks and report back.
  server.registerTool(
    "acp_wait_task",
    {
      title: "Wait for ACP Task",
      description:
        "Wait for an asynchronous ACP task dispatched via acp_dispatch_task to finish (completed, failed, or cancelled) and return its structured summary, touched files, tool calls, and final response. Intended for background watcher subagents so the main conversation stays unblocked.",
      inputSchema: {
        task_id: z.string().min(1).describe("Task ID returned by acp_dispatch_task."),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(150)
          .optional()
          .describe(
            "Maximum seconds to wait in this call before returning current snapshot (default 120, max 150 to stay safely below MCP transport timeout).",
          ),
        return_on_approval: z
          .boolean()
          .optional()
          .describe(
            "Set true to return early if the task pauses on waiting_approval so the watcher can alert the user (default false).",
          ),
      },
    },
    async (args) => {
      try {
        const waitRes = await hub.waitTask(args.task_id, {
          timeoutSeconds: args.timeout_seconds ?? 120,
          returnOnApproval: args.return_on_approval ?? false,
        });
        return {
          content: [{ type: "text", text: formatWaitResult(waitRes) }],
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  // --- App-Only tools (strictly hidden from LLM models) ---

  server.registerTool(
    "acp_ui_get_workspace",
    {
      title: "Get ACP Task Workspace Snapshot",
      description: "App-only tool to fetch the full task list and active task detail.",
      inputSchema: {
        task_id: z.string().optional().describe("Optional task ID to focus."),
      },
      _meta: APP_ONLY_META,
    },
    async (args = {}) => {
      try {
        const snapshot = hub.getWorkspaceSnapshot({
          activeTaskId: args.task_id ?? null,
        });
        return {
          content: [{ type: "text", text: formatWorkspaceSummary(snapshot) }],
          structuredContent: snapshot,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_poll_task",
    {
      title: "Poll ACP Task Incremental State",
      description:
        "App-only tool for lightweight incremental polling of the focused task and global pending approval counters.",
      inputSchema: {
        task_id: z.string().optional().describe("Focused task ID."),
        since_seq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Last observed sequence number for task_id."),
      },
      _meta: APP_ONLY_META,
    },
    async (args = {}) => {
      try {
        const polled = hub.pollTask(args.task_id ?? null, {
          sinceSeq: args.since_seq ?? 0,
        });
        return {
          content: [
            {
              type: "text",
              text: `poll task=${polled.activeTaskId ?? "none"} seq=${polled.seq} unchanged=${polled.unchanged}`,
            },
          ],
          structuredContent: polled,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_follow_up_task",
    {
      title: "Send Follow-up to ACP Task",
      description:
        "App-only tool allowing the user to send a follow-up prompt directly from the right-hand ACP Task Pane.",
      inputSchema: {
        task_id: z.string().min(1).describe("Target task ID."),
        message: z.string().min(1).describe("Follow-up prompt text."),
        approval_policy: approvalPolicySchema,
        mode: z.string().optional().describe("Optional mode override for this turn."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await hub.followUpTask({
          taskId: args.task_id,
          message: args.message,
          approvalPolicy: args.approval_policy,
          mode: args.mode,
        });
        return {
          content: [{ type: "text", text: formatDispatchedSummary(res) }],
          structuredContent: res.workspace,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_resolve_approval",
    {
      title: "Resolve Pending ACP Permission Approval",
      description:
        "App-only tool for human users to approve or reject a suspended ACP permission request in the right-hand ACP Task Pane.",
      inputSchema: {
        approval_id: z.string().min(1).describe("Pending approval ID."),
        decision: z
          .enum(["allow_once", "allow_edits_turn", "allow_all_turn", "reject"])
          .describe("Human decision for this pending tool permission request."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = hub.resolveApproval(args.approval_id, args.decision);
        return {
          content: [
            {
              type: "text",
              text: `Approval ${args.approval_id} resolved with decision=${args.decision}.`,
            },
          ],
          structuredContent: res.workspace,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_cancel_task",
    {
      title: "Cancel Running ACP Task",
      description: "App-only tool to cancel a running ACP task turn from the right-hand pane.",
      inputSchema: {
        task_id: z.string().min(1).describe("Target task ID to cancel."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await hub.cancelTask(args.task_id);
        return {
          content: [{ type: "text", text: `Cancelled ACP task ${args.task_id}.` }],
          structuredContent: res.workspace,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_close_task_session",
    {
      title: "Close ACP Task Session",
      description: "App-only tool to close the ACP session backing a task from the right-hand pane.",
      inputSchema: {
        task_id: z.string().min(1).describe("Target task ID whose session should be closed."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await hub.closeTaskSession(args.task_id);
        return {
          content: [{ type: "text", text: `Closed session for ACP task ${args.task_id}.` }],
          structuredContent: res.workspace,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );
}
