import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { CLIENT_METHODS, RequestError } from "@agentclientprotocol/sdk";
import { canClientOperationProceed, isPathAllowed } from "./permission-policy.mjs";

const DEFAULT_OUTPUT_BYTE_LIMIT = 64 * 1024;

function truncateFromStartUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) {
    return { buffer: buf, truncated: false };
  }
  let start = buf.length - maxBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx) to stay on a valid char boundary.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return { buffer: buf.subarray(start), truncated: true };
}

/**
 * Optional Client-side ACP capability proxy for minimal ACP Harnesses that do
 * not bundle their own filesystem or terminal tools.
 *
 * All operations are strictly gated by:
 * 1. The active turn/session approval_policy
 * 2. The session workspace path allowlist (cwd + additionalDirectories)
 */
export class ClientCapabilitiesProxy {
  constructor({ harnessId, fsEnabled = false, terminalEnabled = false, getSessionContext }) {
    this.harnessId = harnessId;
    this.fsEnabled = Boolean(fsEnabled);
    this.terminalEnabled = Boolean(terminalEnabled);
    this.getSessionContext = getSessionContext;
    this.terminals = new Map();
  }

  toInitializeCapabilities() {
    const caps = {
      elicitation: { form: {} },
    };
    if (this.fsEnabled) {
      caps.fs = {
        readTextFile: true,
        writeTextFile: true,
      };
    }
    if (this.terminalEnabled) {
      caps.terminal = true;
    }
    return caps;
  }

  attachToClientApp(app) {
    if (this.fsEnabled) {
      app
        .onRequest(CLIENT_METHODS.fs_read_text_file, ({ params }) =>
          this.#handleReadTextFile(params),
        )
        .onRequest(CLIENT_METHODS.fs_write_text_file, ({ params }) =>
          this.#handleWriteTextFile(params),
        );
    }

    if (this.terminalEnabled) {
      app
        .onRequest(CLIENT_METHODS.terminal_create, ({ params }) =>
          this.#handleTerminalCreate(params),
        )
        .onRequest(CLIENT_METHODS.terminal_output, ({ params }) =>
          this.#handleTerminalOutput(params),
        )
        .onRequest(CLIENT_METHODS.terminal_wait_for_exit, ({ params }) =>
          this.#handleTerminalWaitForExit(params),
        )
        .onRequest(CLIENT_METHODS.terminal_kill, ({ params }) =>
          this.#handleTerminalKill(params),
        )
        .onRequest(CLIENT_METHODS.terminal_release, ({ params }) =>
          this.#handleTerminalRelease(params),
        );
    }
  }

  #requireContext(sessionId) {
    const ctx = this.getSessionContext(sessionId);
    if (!ctx) {
      throw RequestError.invalidParams(
        { sessionId },
        `Unknown ACP session for client capability call: ${sessionId}`,
      );
    }
    return ctx;
  }

  async #handleReadTextFile(params) {
    const ctx = this.#requireContext(params.sessionId);
    const targetPath = params.path;

    if (!canClientOperationProceed(ctx.policy, "fs_read")) {
      ctx.recordDenied({
        toolName: "fs/read_text_file",
        kind: "read",
        title: `Read ${targetPath}`,
        inputSummary: JSON.stringify({ path: targetPath }),
        policy: ctx.policy,
      });
      throw RequestError.invalidRequest(
        { policy: ctx.policy, path: targetPath },
        `fs/read_text_file denied by approval_policy="${ctx.policy}"`,
      );
    }

    if (!isPathAllowed(targetPath, ctx.allowedRoots)) {
      ctx.recordDenied({
        toolName: "fs/read_text_file",
        kind: "read",
        title: `Read outside workspace: ${targetPath}`,
        inputSummary: JSON.stringify({ path: targetPath }),
        policy: ctx.policy,
      });
      throw RequestError.invalidParams(
        { path: targetPath },
        `Path is outside allowed workspace directories: ${targetPath}`,
      );
    }

    let content = await readFile(targetPath, "utf8");
    if (params.line != null || params.limit != null) {
      const lines = content.split(/\r?\n/);
      const startIdx = Math.max(0, (params.line ?? 1) - 1);
      const endIdx = params.limit != null ? startIdx + Math.max(0, params.limit) : lines.length;
      content = lines.slice(startIdx, endIdx).join("\n");
    }
    return { content };
  }

  async #handleWriteTextFile(params) {
    const ctx = this.#requireContext(params.sessionId);
    const targetPath = params.path;

    if (!canClientOperationProceed(ctx.policy, "fs_write")) {
      ctx.recordDenied({
        toolName: "fs/write_text_file",
        kind: "edit",
        title: `Write ${targetPath}`,
        inputSummary: JSON.stringify({ path: targetPath, bytes: String(params.content ?? "").length }),
        policy: ctx.policy,
      });
      throw RequestError.invalidRequest(
        { policy: ctx.policy, path: targetPath },
        `fs/write_text_file denied by approval_policy="${ctx.policy}"`,
      );
    }

    if (!isPathAllowed(targetPath, ctx.allowedRoots)) {
      ctx.recordDenied({
        toolName: "fs/write_text_file",
        kind: "edit",
        title: `Write outside workspace: ${targetPath}`,
        inputSummary: JSON.stringify({ path: targetPath }),
        policy: ctx.policy,
      });
      throw RequestError.invalidParams(
        { path: targetPath },
        `Path is outside allowed workspace directories: ${targetPath}`,
      );
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, String(params.content ?? ""), "utf8");
    return {};
  }

  async #handleTerminalCreate(params) {
    const ctx = this.#requireContext(params.sessionId);
    const workdir = params.cwd || ctx.session.cwd;

    if (!canClientOperationProceed(ctx.policy, "terminal")) {
      ctx.recordDenied({
        toolName: "terminal/create",
        kind: "execute",
        title: `Run ${params.command}`,
        inputSummary: JSON.stringify({
          command: params.command,
          args: params.args ?? [],
          cwd: workdir,
        }),
        policy: ctx.policy,
      });
      throw RequestError.invalidRequest(
        { policy: ctx.policy },
        `terminal/create denied by approval_policy="${ctx.policy}" (requires allow_all)`,
      );
    }

    if (!isAbsolute(workdir) || !isPathAllowed(workdir, ctx.allowedRoots)) {
      ctx.recordDenied({
        toolName: "terminal/create",
        kind: "execute",
        title: `Run outside workspace: ${workdir}`,
        inputSummary: JSON.stringify({ command: params.command, cwd: workdir }),
        policy: ctx.policy,
      });
      throw RequestError.invalidParams(
        { cwd: workdir },
        `Terminal cwd is outside allowed workspace directories: ${workdir}`,
      );
    }

    const extraEnv = {};
    for (const item of params.env ?? []) {
      if (item && typeof item.name === "string") {
        extraEnv[item.name] = String(item.value ?? "");
      }
    }

    const child = spawn(params.command, params.args ?? [], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });

    const terminalId = `term_${randomUUID().slice(0, 12)}`;
    const maxBytes =
      typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : DEFAULT_OUTPUT_BYTE_LIMIT;

    let resolveExit;
    const waitPromise = new Promise((res) => {
      resolveExit = res;
    });

    const state = {
      terminalId,
      sessionId: params.sessionId,
      child,
      outputBuffer: Buffer.alloc(0),
      truncated: false,
      maxBytes,
      exitStatus: null,
      waitPromise,
    };

    const appendChunk = (chunk) => {
      const combined = Buffer.concat([state.outputBuffer, Buffer.from(chunk)]);
      const { buffer, truncated } = truncateFromStartUtf8(combined, state.maxBytes);
      state.outputBuffer = buffer;
      if (truncated) state.truncated = true;
    };

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);

    child.on("exit", (exitCode, signal) => {
      state.exitStatus = { exitCode: exitCode ?? null, signal: signal ?? null };
      resolveExit(state.exitStatus);
    });

    child.on("error", (err) => {
      appendChunk(`\n[terminal spawn error] ${err.message}\n`);
      state.exitStatus = { exitCode: 1, signal: null };
      resolveExit(state.exitStatus);
    });

    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  #getTerminal(params) {
    const state = this.terminals.get(params.terminalId);
    if (!state || state.sessionId !== params.sessionId) {
      throw RequestError.resourceNotFound(params.terminalId);
    }
    return state;
  }

  #handleTerminalOutput(params) {
    const state = this.#getTerminal(params);
    return {
      output: state.outputBuffer.toString("utf8"),
      truncated: state.truncated,
      exitStatus: state.exitStatus,
    };
  }

  async #handleTerminalWaitForExit(params) {
    const state = this.#getTerminal(params);
    const status = await state.waitPromise;
    return {
      exitCode: status.exitCode,
      signal: status.signal,
    };
  }

  #handleTerminalKill(params) {
    const state = this.#getTerminal(params);
    if (state.child.exitCode === null && !state.child.killed) {
      state.child.kill();
    }
    return {};
  }

  #handleTerminalRelease(params) {
    const state = this.#getTerminal(params);
    if (state.child.exitCode === null && !state.child.killed) {
      state.child.kill();
    }
    this.terminals.delete(params.terminalId);
    return {};
  }

  releaseSessionTerminals(sessionId) {
    for (const [terminalId, state] of this.terminals.entries()) {
      if (state.sessionId === sessionId) {
        if (state.child.exitCode === null && !state.child.killed) {
          state.child.kill();
        }
        this.terminals.delete(terminalId);
      }
    }
  }

  disposeAll() {
    for (const state of this.terminals.values()) {
      if (state.child.exitCode === null && !state.child.killed) {
        state.child.kill();
      }
    }
    this.terminals.clear();
  }
}
