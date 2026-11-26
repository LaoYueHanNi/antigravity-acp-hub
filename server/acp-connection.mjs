import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  client as createAcpClient,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { ClientCapabilitiesProxy } from "./client-capabilities.mjs";

const MAX_STDERR_LINES = 80;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

export function summarizeAgentCapabilities(initInfo) {
  const caps = initInfo?.agentCapabilities ?? {};
  const sessionCaps = caps.sessionCapabilities ?? {};
  const promptCaps = caps.promptCapabilities ?? {};

  return {
    protocolVersion: initInfo?.protocolVersion ?? null,
    agentInfo: initInfo?.agentInfo ?? null,
    loadSession: Boolean(caps.loadSession),
    listSessions: sessionCaps.list != null,
    deleteSession: sessionCaps.delete != null,
    closeSession: sessionCaps.close != null,
    resumeSession: sessionCaps.resume != null,
    additionalDirectories: sessionCaps.additionalDirectories != null,
    imagePrompt: Boolean(promptCaps.image),
    audioPrompt: Boolean(promptCaps.audio),
    embeddedContext: Boolean(promptCaps.embeddedContext),
    authMethods: (initInfo?.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
    })),
    raw: caps,
  };
}

/**
 * Manages one persistent ACP child process and JSON-RPC connection for a single Harness.
 */
export class AcpConnection {
  constructor({ harnessConfig, execution, callbacks, initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS }) {
    this.harnessId = harnessConfig.id;
    this.harnessConfig = harnessConfig;
    this.execution = execution;
    this.callbacks = callbacks;
    this.initTimeoutMs = initTimeoutMs;

    this.child = null;
    this.connection = null;
    this.connectingPromise = null;
    this.stderrLines = [];
    this.initInfo = null;
    this.capabilities = null;
    this.status = "idle";
    this.lastError = null;

    this.clientProxy = new ClientCapabilitiesProxy({
      harnessId: this.harnessId,
      fsEnabled: Boolean(harnessConfig.clientCapabilities?.fs),
      terminalEnabled: Boolean(harnessConfig.clientCapabilities?.terminal),
      getSessionContext: (nativeSessionId) =>
        this.callbacks.getSessionContext?.(this.harnessId, nativeSessionId) ?? null,
    });
  }

  isAlive() {
    return Boolean(
      this.connection &&
        !this.connection.signal?.aborted &&
        this.child &&
        this.child.exitCode === null &&
        !this.child.killed,
    );
  }

  recentStderr(limit = 15) {
    return this.stderrLines.slice(-limit).join("\n");
  }

  async ensureConnected() {
    if (this.isAlive()) {
      return this.connection;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.status = "connecting";
    this.lastError = null;
    this.connectingPromise = this.#startConnection()
      .then((conn) => {
        this.status = "connected";
        return conn;
      })
      .catch((err) => {
        this.status = "error";
        this.lastError = err.message;
        throw err;
      })
      .finally(() => {
        this.connectingPromise = null;
      });

    return this.connectingPromise;
  }

  async #startConnection() {
    if (!this.execution?.runnable || !this.execution.spawnCommand) {
      const hint = this.execution?.installHint ? ` (${this.execution.installHint})` : "";
      throw new Error(`Harness "${this.harnessId}" is not installed or runnable${hint}`);
    }

    const spawnEnv = {
      ...process.env,
      ...(this.harnessConfig.env ?? {}),
    };

    const child = spawn(this.execution.spawnCommand, this.execution.spawnArgs ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: spawnEnv,
    });

    this.stderrLines = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > MAX_STDERR_LINES) {
          this.stderrLines.shift();
        }
      }
    });

    const writable = Writable.toWeb(child.stdin);
    const readable = Readable.toWeb(child.stdout);
    const stream = ndJsonStream(writable, readable);

    const app = createAcpClient({ name: `antigravity-acp-hub:${this.harnessId}` })
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
        this.callbacks.onSessionUpdate?.(this.harnessId, params);
      })
      .onRequest(CLIENT_METHODS.session_request_permission, ({ params }) => {
        return this.callbacks.onPermissionRequest?.(this.harnessId, params);
      })
      .onRequest(CLIENT_METHODS.elicitation_create, ({ params }) => {
        return (
          this.callbacks.onElicitation?.(this.harnessId, params) ?? { action: "cancel" }
        );
      });

    this.clientProxy.attachToClientApp(app);

    const connection = app.connect(stream);
    this.child = child;
    this.connection = connection;

    let spawnError = null;
    let disconnectNotified = false;
    const notifyDisconnectOnce = (err) => {
      if (disconnectNotified) return;
      disconnectNotified = true;
      if (this.child === child) {
        this.child = null;
        this.connection = null;
        this.status = "idle";
        this.clientProxy.disposeAll();
        this.callbacks.onDisconnect?.(this.harnessId, err);
      }
    };

    child.on("error", (err) => {
      spawnError = err;
      this.status = "error";
      this.lastError = err.message;
      notifyDisconnectOnce(err);
    });

    connection.closed.then(() => {
      const detail = this.recentStderr();
      const reason = `ACP harness "${this.harnessId}" connection closed${detail ? `\n${detail}` : ""}`;
      notifyDisconnectOnce(new Error(reason));
    });

    child.on("exit", (code, signal) => {
      const detail = this.recentStderr();
      const reason = `ACP harness "${this.harnessId}" exited (code=${code}, signal=${signal})${detail ? `\n${detail}` : ""}`;
      notifyDisconnectOnce(new Error(reason));
    });

    const initController = new AbortController();
    const initTimer = setTimeout(() => initController.abort(), this.initTimeoutMs);

    try {
      this.initInfo = await connection.agent.request(
        AGENT_METHODS.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: "antigravity-acp-hub",
            version: "2.0.0",
          },
          clientCapabilities: this.clientProxy.toInitializeCapabilities(),
        },
        { signal: initController.signal },
      );
      this.capabilities = summarizeAgentCapabilities(this.initInfo);
    } catch (err) {
      const detail = this.recentStderr();
      const baseMsg = spawnError ? spawnError.message : err.message;
      this.disposeSync();
      throw new Error(
        `Failed to initialize ACP harness "${this.harnessId}": ${baseMsg}${detail ? `\nRecent stderr:\n${detail}` : ""}`,
      );
    } finally {
      clearTimeout(initTimer);
    }

    return connection;
  }

  async request(method, params, options) {
    const conn = await this.ensureConnected();
    return conn.agent.request(method, params, options);
  }

  async notify(method, params) {
    const conn = await this.ensureConnected();
    return conn.agent.notify(method, params);
  }

  releaseSessionResources(nativeSessionId) {
    this.clientProxy.releaseSessionTerminals(nativeSessionId);
  }

  disposeSync() {
    this.clientProxy.disposeAll();
    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // ignore close errors
      }
      this.connection = null;
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // ignore kill errors
      }
    }
    this.child = null;
    this.status = "idle";
  }

  async dispose() {
    this.disposeSync();
  }
}
