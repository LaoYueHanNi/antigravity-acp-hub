import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APPROVAL_POLICIES, AcpHub } from "./acp-hub.mjs";
import { registerDashboardApp } from "./dashboard-resource.mjs";

const hub = new AcpHub();

const server = new McpServer({
  name: "antigravity-acp-hub",
  version: "2.0.0",
});

registerDashboardApp(server, hub);

function formatTurnResult(result) {
  const header = [
    `[ACP:${result.harness}]`,
    `sessionId=${result.sessionId}`,
    `mode=${result.mode ?? "default"}`,
    `approvalPolicy=${result.approvalPolicy}`,
    `stopReason=${result.stopReason}`,
  ].join(" | ");

  const lines = [header];
  if (result.model) {
    lines.push(`model: ${result.model}`);
  }
  if (result.warnings?.length) {
    lines.push(`warnings:\n- ${result.warnings.join("\n- ")}`);
  }
  if (result.deniedPermissions?.length) {
    lines.push("denied_permissions (blocked by approval_policy):");
    for (const item of result.deniedPermissions) {
      const loc = item.locations?.length ? ` locations=${item.locations.join(",")}` : "";
      lines.push(
        `- tool=${item.toolName} kind=${item.kind || "unknown"} title="${item.title}"${loc} input=${item.inputSummary}`,
      );
    }
  }
  if (result.elicitations?.length) {
    lines.push("agent_questions (needs user clarification):");
    for (const q of result.elicitations) {
      lines.push(`- ${q.message}`);
    }
  }
  if (result.toolCalls?.length) {
    lines.push(
      `tool_calls (${result.toolCalls.length}): ${result.toolCalls
        .map((tc) => `${tc.toolName}[${tc.status}]`)
        .join(", ")}`,
    );
  }
  if (result.plan?.length) {
    lines.push(
      `plan:\n${result.plan.map((p) => `- [${p.status ?? "pending"}] ${p.content}`).join("\n")}`,
    );
  }
  if (result.text) {
    lines.push("", result.text);
  } else {
    lines.push("", "(No assistant text returned)");
  }
  return lines.join("\n");
}

function toolError(err, harnessId = null) {
  const stderr = hub.recentStderr(harnessId);
  const detail = stderr ? `${err.message}\n\nRecent ACP stderr:\n${stderr}` : err.message;
  return {
    isError: true,
    content: [{ type: "text", text: detail }],
  };
}

const approvalPolicySchema = z
  .enum(APPROVAL_POLICIES)
  .optional()
  .describe(
    "Bridge approval callback policy: read_only (default; allow read/search/fetch only, fail-closed on writes/deletes/shell), accept_edits (allow read + file edits, still block delete/move/execute), allow_all (approve all permission prompts for this call), reject_all (deny all permission prompts).",
  );

const configOptionsSchema = z
  .record(z.string(), z.union([z.string(), z.boolean()]))
  .optional()
  .describe(
    "Optional ACP session config options passed via session/set_config_option (e.g. { effort: 'high' } or harness-specific option ids).",
  );

server.registerTool(
  "acp_list_harnesses",
  {
    title: "List Configured ACP Harnesses",
    description:
      "List all configured ACP harnesses (built-in presets + user overrides from ~/.gemini/config/acp-harnesses.json), local binary installation status, active connection state, and negotiated capabilities. Set probe=true to actively run an ACP initialize handshake for local diagnostics.",
    inputSchema: {
      harness: z
        .string()
        .optional()
        .describe("Optional harness ID to inspect (e.g. claude, codex, gemini, opencode, goose)."),
      probe: z
        .boolean()
        .optional()
        .describe(
          "Set true to connect and run ACP initialize handshake to inspect live agentCapabilities and authMethods (default false).",
        ),
    },
  },
  async (args) => {
    try {
      const data = await hub.listHarnesses({
        harness: args.harness ?? null,
        probe: args.probe ?? false,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return toolError(err, args.harness ?? null);
    }
  },
);

server.registerTool(
  "acp_new_session",
  {
    title: "Create ACP Session",
    description:
      "Start a persistent stateful session on any configured ACP harness in the given working directory. Returns a composite session_id (<harness>:<nativeId>). Optionally executes an initial_prompt in the same call with dynamic per-call mode and approval_policy.",
    inputSchema: {
      harness: z
        .string()
        .describe(
          "Target ACP harness ID (e.g. claude, codex, gemini, opencode, goose, or a custom ID from acp-harnesses.json). Use acp_list_harnesses to see installed harnesses.",
        ),
      cwd: z.string().describe("Absolute path to the working directory for the session."),
      mode: z
        .string()
        .optional()
        .describe(
          "Optional harness-specific ACP session mode id (e.g. default, plan, acceptEdits, bypassPermissions for Claude; inspect availableModes from response).",
        ),
      approval_policy: approvalPolicySchema,
      model: z.string().optional().describe("Optional model ID supported by the target harness."),
      config_options: configOptionsSchema,
      additional_directories: z
        .array(z.string())
        .optional()
        .describe(
          "Optional additional absolute directory paths accessible to the session (forwarded only if the harness advertises additionalDirectories).",
        ),
      initial_prompt: z
        .string()
        .optional()
        .describe("Optional prompt to execute immediately after creating the session."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in seconds if initial_prompt is provided (default 300)."),
    },
  },
  async (args) => {
    try {
      const created = await hub.newSession({
        harness: args.harness,
        cwd: args.cwd,
        mode: args.mode,
        approvalPolicy: args.approval_policy,
        model: args.model,
        configOptions: args.config_options,
        additionalDirectories: args.additional_directories,
      });

      if (!args.initial_prompt) {
        return {
          content: [{ type: "text", text: JSON.stringify(created, null, 2) }],
        };
      }

      const turnResult = await hub.prompt({
        sessionId: created.sessionId,
        message: args.initial_prompt,
        mode: args.mode,
        approvalPolicy: args.approval_policy,
        model: args.model,
        configOptions: args.config_options,
        timeoutSeconds: args.timeout_seconds,
      });

      if (created.warnings?.length) {
        turnResult.warnings = [...created.warnings, ...(turnResult.warnings ?? [])];
      }

      return {
        content: [{ type: "text", text: formatTurnResult(turnResult) }],
      };
    } catch (err) {
      return toolError(err, args.harness);
    }
  },
);

server.registerTool(
  "acp_prompt",
  {
    title: "Prompt ACP Session",
    description:
      "Send a prompt to an existing ACP session (automatically routed to its owning harness via composite session_id). Preserves multi-turn context and lets you dynamically override mode, approval_policy, model, or config_options for this turn.",
    inputSchema: {
      session_id: z
        .string()
        .describe("Composite session ID (<harness>:<nativeId>) returned by acp_new_session or acp_load_session."),
      message: z.string().describe("Prompt text to send to the agent."),
      mode: z.string().optional().describe("Optional ACP session mode override for this turn."),
      approval_policy: approvalPolicySchema,
      model: z.string().optional().describe("Optional model override for this session."),
      config_options: configOptionsSchema,
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in seconds for this turn (default 300)."),
    },
  },
  async (args) => {
    try {
      const result = await hub.prompt({
        sessionId: args.session_id,
        message: args.message,
        mode: args.mode,
        approvalPolicy: args.approval_policy,
        model: args.model,
        configOptions: args.config_options,
        timeoutSeconds: args.timeout_seconds,
      });
      return {
        content: [{ type: "text", text: formatTurnResult(result) }],
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "acp_load_session",
  {
    title: "Load Saved ACP Session",
    description:
      "Load/resume a previously persisted session on a harness that advertises ACP loadSession capability. Accepts either a composite session_id (<harness>:<nativeId>) or a native session_id paired with the harness parameter.",
    inputSchema: {
      session_id: z.string().describe("Composite or native persisted session ID to resume."),
      cwd: z.string().describe("Absolute path to the working directory for the session."),
      harness: z
        .string()
        .optional()
        .describe("Target harness ID (required when session_id does not carry a '<harness>:' prefix)."),
      mode: z.string().optional().describe("Optional ACP session mode override."),
      approval_policy: approvalPolicySchema,
      model: z.string().optional().describe("Optional model override."),
      config_options: configOptionsSchema,
    },
  },
  async (args) => {
    try {
      const loaded = await hub.loadSession({
        sessionId: args.session_id,
        harness: args.harness,
        cwd: args.cwd,
        mode: args.mode,
        approvalPolicy: args.approval_policy,
        model: args.model,
        configOptions: args.config_options,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(loaded, null, 2) }],
      };
    } catch (err) {
      return toolError(err, args.harness ?? null);
    }
  },
);

server.registerTool(
  "acp_list_sessions",
  {
    title: "List ACP Sessions",
    description:
      "List active in-memory ACP sessions across all harnesses (or a single harness) and optionally query persisted session history from harnesses that support ACP session/list.",
    inputSchema: {
      harness: z.string().optional().describe("Optional harness ID filter."),
      cwd: z.string().optional().describe("Optional absolute directory path filter."),
      include_history: z
        .boolean()
        .optional()
        .describe(
          "Set true to also query persisted session history via ACP session/list (requires harness or an already connected harness).",
        ),
    },
  },
  async (args) => {
    try {
      const data = await hub.listSessions({
        harness: args.harness ?? null,
        cwd: args.cwd ?? null,
        includeHistory: args.include_history ?? false,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return toolError(err, args.harness ?? null);
    }
  },
);

server.registerTool(
  "acp_cancel",
  {
    title: "Cancel ACP Turn",
    description: "Send ACP session/cancel to interrupt an ongoing turn in an active session.",
    inputSchema: {
      session_id: z.string().describe("Composite session ID (<harness>:<nativeId>) to cancel."),
    },
  },
  async (args) => {
    try {
      const res = await hub.cancel(args.session_id);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "acp_close_session",
  {
    title: "Close ACP Session",
    description:
      "Close an active ACP session, release any associated client-proxy terminals, and clean up hub state.",
    inputSchema: {
      session_id: z.string().describe("Composite session ID (<harness>:<nativeId>) to close."),
    },
  },
  async (args) => {
    try {
      const res = await hub.closeSession(args.session_id);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await hub.dispose().catch(() => {});
  await server.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
