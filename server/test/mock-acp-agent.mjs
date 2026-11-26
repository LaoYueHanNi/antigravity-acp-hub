import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  RequestError,
  agent as createAcpAgent,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const agentName = process.env.MOCK_AGENT_NAME || "mock-agent";
const supportsLoad = process.env.MOCK_LOAD_SESSION !== "false";
const supportsList = process.env.MOCK_LIST_SESSIONS !== "false";
const supportsSetMode = process.env.MOCK_SUPPORT_SET_MODE !== "false";
const supportsAdditionalDirs = process.env.MOCK_SUPPORT_ADDITIONAL_DIRS !== "false";

let seq = 0;
const sessions = new Map();
const persistedHistory = new Map();
const activeCancels = new Map();

function extractText(promptBlocks) {
  return (promptBlocks ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const app = createAcpAgent({ name: agentName })
  .onRequest(AGENT_METHODS.initialize, ({ params }) => {
    const sessionCapabilities = {};
    if (supportsList) sessionCapabilities.list = {};
    if (supportsAdditionalDirs) sessionCapabilities.additionalDirectories = {};
    sessionCapabilities.close = {};

    return {
      protocolVersion: Math.min(params.protocolVersion ?? PROTOCOL_VERSION, PROTOCOL_VERSION),
      agentInfo: {
        name: agentName,
        version: "1.0.0-mock",
      },
      agentCapabilities: {
        loadSession: supportsLoad,
        sessionCapabilities,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [{ id: "mock-auth", name: "Mock Ready" }],
    };
  })
  .onRequest(AGENT_METHODS.session_new, ({ params }) => {
    seq += 1;
    const sessionId = `sess_${seq}`;
    const state = {
      sessionId,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
      mode: "default",
      model: "mock-model-1",
      turns: [],
    };
    sessions.set(sessionId, state);
    persistedHistory.set(sessionId, {
      sessionId,
      cwd: params.cwd,
      title: `${agentName}:${sessionId}`,
    });

    return {
      sessionId,
      modes: {
        currentModeId: state.mode,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
          { id: "acceptEdits", name: "Accept Edits" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: state.model,
          options: [
            { value: "mock-model-1", name: "Mock 1" },
            { value: "mock-model-2", name: "Mock 2" },
          ],
        },
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    };
  })
  .onRequest(AGENT_METHODS.session_load, ({ params }) => {
    if (!supportsLoad) {
      throw RequestError.methodNotFound("session/load");
    }
    const existing = sessions.get(params.sessionId) ?? {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mode: "default",
      model: "mock-model-1",
      turns: ["restored"],
    };
    sessions.set(params.sessionId, existing);
    return {
      modes: {
        currentModeId: existing.mode,
        availableModes: [{ id: "default", name: "Default" }],
      },
    };
  })
  .onRequest(AGENT_METHODS.session_list, ({ params }) => {
    if (!supportsList) {
      throw RequestError.methodNotFound("session/list");
    }
    const items = Array.from(persistedHistory.values()).filter(
      (s) => !params?.cwd || s.cwd === params.cwd,
    );
    return { sessions: items };
  })
  .onRequest(AGENT_METHODS.session_set_mode, ({ params }) => {
    if (!supportsSetMode) {
      throw RequestError.methodNotFound("session/set_mode");
    }
    const state = sessions.get(params.sessionId);
    if (!state) throw RequestError.resourceNotFound(params.sessionId);
    state.mode = params.modeId;
    return {};
  })
  .onRequest(AGENT_METHODS.session_set_config_option, ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw RequestError.resourceNotFound(params.sessionId);
    if (params.configId === "model") {
      state.model = String(params.value);
    }
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: state.model,
          options: [
            { value: "mock-model-1", name: "Mock 1" },
            { value: "mock-model-2", name: "Mock 2" },
          ],
        },
      ],
    };
  })
  .onRequest(AGENT_METHODS.session_close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(AGENT_METHODS.session_cancel, ({ params }) => {
    const cancelFn = activeCancels.get(params.sessionId);
    if (cancelFn) cancelFn();
  })
  .onRequest(AGENT_METHODS.session_prompt, async ({ params, client }) => {
    const state = sessions.get(params.sessionId);
    if (!state) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    const text = extractText(params.prompt).trim();
    state.turns.push(text);

    const sendChunk = async (chunkText) => {
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunkText },
        },
      });
    };

    if (text === "crash") {
      process.stderr.write(`${agentName}: intentional crash triggered\n`);
      setTimeout(() => process.exit(42), 20);
      await new Promise(() => {});
    }

    if (text.startsWith("stream_task:")) {
      const targetFile = text.slice("stream_task:".length).trim() || "README.md";
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Inspect target file", status: "in_progress", priority: "high" },
            { content: "Summarize findings", status: "pending", priority: "medium" },
          ],
        },
      });
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `thinking about ${targetFile}` },
        },
      });
      const tcId = `tc_stream_${Date.now()}`;
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: tcId,
          title: `Read ${targetFile}`,
          kind: "read",
          status: "in_progress",
          locations: [{ path: targetFile }],
          rawInput: { file_path: targetFile },
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: tcId,
          status: "completed",
        },
      });
      await sendChunk("stream_part_1 ");
      await new Promise((r) => setTimeout(r, 30));
      await sendChunk("stream_part_2");
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Inspect target file", status: "completed", priority: "high" },
            { content: "Summarize findings", status: "completed", priority: "medium" },
          ],
        },
      });
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("perm_edit_twice:")) {
      const filePath = text.slice("perm_edit_twice:".length).trim() || "demo.txt";
      const outcomes = [];
      for (const idx of [1, 2]) {
        const tcId = `tc_edit_${idx}_${Date.now()}`;
        await client.notify(CLIENT_METHODS.session_update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: tcId,
            title: `Edit ${filePath} #${idx}`,
            kind: "edit",
            status: "pending",
            locations: [{ path: filePath }],
            rawInput: {
              file_path: filePath,
              old_string: `old_${idx}`,
              new_string: `new_${idx}`,
            },
          },
        });

        const permRes = await client.request(CLIENT_METHODS.session_request_permission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: tcId,
            title: `Edit ${filePath} #${idx}`,
            kind: "edit",
            locations: [{ path: filePath }],
            rawInput: {
              file_path: filePath,
              old_string: `old_${idx}`,
              new_string: `new_${idx}`,
            },
          },
          options: [
            { optionId: "allow-once-id", name: "Allow Once", kind: "allow_once" },
            { optionId: "reject-once-id", name: "Reject Once", kind: "reject_once" },
          ],
        });

        const approved = permRes?.outcome?.optionId === "allow-once-id";
        outcomes.push(approved ? "approved" : "denied");
        await client.notify(CLIENT_METHODS.session_update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: tcId,
            status: approved ? "completed" : "failed",
          },
        });
      }
      await sendChunk(`edit_twice_result:${outcomes.join(",")}`);
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("perm:")) {
      const [, kind, toolName] = text.split(":");
      const toolCallId = `tc_${Date.now()}`;
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolName,
          kind: kind || "other",
          status: "pending",
          rawInput: { target: "demo.txt" },
        },
      });

      const permRes = await client.request(CLIENT_METHODS.session_request_permission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId,
          title: toolName,
          kind: kind || "other",
          rawInput: { target: "demo.txt" },
        },
        options: [
          { optionId: "allow-once-id", name: "Allow Once", kind: "allow_once" },
          { optionId: "allow-always-id", name: "Allow Always", kind: "allow_always" },
          { optionId: "reject-once-id", name: "Reject Once", kind: "reject_once" },
        ],
      });

      const approved = permRes?.outcome?.optionId === "allow-once-id";
      await client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: approved ? "completed" : "failed",
        },
      });

      await sendChunk(
        `perm_result:${approved ? "approved" : "denied"}:${permRes?.outcome?.optionId ?? permRes?.outcome?.outcome}`,
      );
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("elicit:")) {
      const question = text.slice("elicit:".length);
      await client.request(CLIENT_METHODS.elicitation_create, {
        sessionId: params.sessionId,
        mode: "form",
        message: question,
        requestedSchema: { type: "object", properties: {} },
      });
      await sendChunk("elicitation_sent");
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("slow:")) {
      const ms = Number(text.slice("slow:".length)) || 5000;
      await sendChunk("partial_before_timeout");
      let cancelled = false;
      await new Promise((resolveWait) => {
        const timer = setTimeout(resolveWait, ms);
        activeCancels.set(params.sessionId, () => {
          cancelled = true;
          clearTimeout(timer);
          resolveWait();
        });
      });
      activeCancels.delete(params.sessionId);
      if (cancelled) {
        return { stopReason: "cancelled" };
      }
      await sendChunk("_finished");
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("fs_read:")) {
      const filePath = text.slice("fs_read:".length);
      try {
        const res = await client.request(CLIENT_METHODS.fs_read_text_file, {
          sessionId: params.sessionId,
          path: filePath,
        });
        await sendChunk(`fs_read_ok:${res.content}`);
      } catch (err) {
        await sendChunk(`fs_read_err:${err.message}`);
      }
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("fs_write:")) {
      const rest = text.slice("fs_write:".length);
      const sep = rest.indexOf("|");
      const filePath = rest.slice(0, sep);
      const content = rest.slice(sep + 1);
      try {
        await client.request(CLIENT_METHODS.fs_write_text_file, {
          sessionId: params.sessionId,
          path: filePath,
          content,
        });
        await sendChunk("fs_write_ok");
      } catch (err) {
        await sendChunk(`fs_write_err:${err.message}`);
      }
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("term:")) {
      const arg = text.slice("term:".length);
      try {
        const created = await client.request(CLIENT_METHODS.terminal_create, {
          sessionId: params.sessionId,
          command: process.execPath,
          args: ["-e", `console.log(${JSON.stringify(arg)})`],
          cwd: state.cwd,
        });
        const exitInfo = await client.request(CLIENT_METHODS.terminal_wait_for_exit, {
          sessionId: params.sessionId,
          terminalId: created.terminalId,
        });
        const out = await client.request(CLIENT_METHODS.terminal_output, {
          sessionId: params.sessionId,
          terminalId: created.terminalId,
        });
        await client.request(CLIENT_METHODS.terminal_release, {
          sessionId: params.sessionId,
          terminalId: created.terminalId,
        });
        await sendChunk(`term_ok:${exitInfo.exitCode}:${out.output.trim()}`);
      } catch (err) {
        await sendChunk(`term_err:${err.message}`);
      }
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("lock_test:")) {
      const [, tag, msStr] = text.split(":");
      const ms = Number(msStr) || 120;
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      const end = Date.now();
      await sendChunk(JSON.stringify({ tag, start, end, agent: agentName }));
      return { stopReason: "end_turn" };
    }

    await sendChunk(
      `[${agentName}] turns=${state.turns.length} mode=${state.mode} model=${state.model} msg=${text}`,
    );
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
