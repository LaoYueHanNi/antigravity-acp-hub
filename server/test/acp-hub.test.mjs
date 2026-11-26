import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AcpHub } from "../acp-hub.mjs";
import { HarnessRegistry } from "../harness-registry.mjs";
import {
  decideApprovalOption,
  isPathAllowed,
  normalizeToolName,
} from "../permission-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT = join(__dirname, "mock-acp-agent.mjs");
const SERVER_INDEX = join(__dirname, "..", "index.mjs");

describe("permission-policy", () => {
  const options = [
    { optionId: "allow-once", kind: "allow_once", name: "Allow Once" },
    { optionId: "allow-always", kind: "allow_always", name: "Allow Always" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject Once" },
  ];

  test("normalizes tool names across casing styles", () => {
    assert.equal(normalizeToolName("ReadFile"), "read_file");
    assert.equal(normalizeToolName("write-text-file"), "write_text_file");
    assert.equal(normalizeToolName("Grep"), "grep");
  });

  test("read_only allows read/search/fetch/think kinds and blocks edit/delete/move/execute", () => {
    for (const kind of ["read", "search", "fetch", "think"]) {
      const res = decideApprovalOption("read_only", { kind, toolName: "anything" }, options);
      assert.equal(res.approved, true, `expected ${kind} allowed`);
      assert.equal(res.outcome.optionId, "allow-once");
    }
    for (const kind of ["edit", "delete", "move", "execute"]) {
      const res = decideApprovalOption("read_only", { kind, toolName: "Read" }, options);
      assert.equal(res.approved, false, `expected ${kind} denied even if toolName looks read-only`);
      assert.equal(res.outcome.optionId, "reject-once");
    }
  });

  test("accept_edits allows read + edit, still blocks delete/move/execute and unknown", () => {
    assert.equal(
      decideApprovalOption("accept_edits", { kind: "edit", toolName: "PatchFile" }, options).approved,
      true,
    );
    assert.equal(
      decideApprovalOption("accept_edits", { kind: "other", toolName: "applyPatch" }, options).approved,
      true,
    );
    for (const kind of ["delete", "move", "execute"]) {
      assert.equal(
        decideApprovalOption("accept_edits", { kind, toolName: "Write" }, options).approved,
        false,
      );
    }
    assert.equal(
      decideApprovalOption("accept_edits", { kind: "other", toolName: "mystery_tool" }, options).approved,
      false,
    );
  });

  test("allow_all prefers allow_once; reject_all blocks everything", () => {
    const allow = decideApprovalOption("allow_all", { kind: "execute", toolName: "Bash" }, options);
    assert.equal(allow.approved, true);
    assert.equal(allow.outcome.optionId, "allow-once");

    const deny = decideApprovalOption("reject_all", { kind: "read", toolName: "Read" }, options);
    assert.equal(deny.approved, false);
  });

  test("isPathAllowed enforces workspace boundary and blocks traversal", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-hub-path-"));
    try {
      const inside = join(base, "sub", "file.txt");
      const outside = join(base, "..", "escape.txt");
      assert.equal(isPathAllowed(inside, [base]), true);
      assert.equal(isPathAllowed(base, [base]), true);
      assert.equal(isPathAllowed(outside, [base]), false);
      assert.equal(isPathAllowed("relative/file.txt", [base]), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("HarnessRegistry", () => {
  test("merges built-in presets with user config and hot-reloads changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-hub-reg-"));
    const cfgPath = join(tempDir, "acp-harnesses.json");
    try {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          defaultHarness: "custom-a",
          harnesses: {
            goose: { enabled: false },
            "custom-a": {
              displayName: "Custom A",
              command: "node",
              args: [MOCK_AGENT],
              clientCapabilities: { fs: true },
            },
          },
        }),
      );

      const registry = new HarnessRegistry({ configPath: cfgPath });
      assert.equal(registry.defaultHarness, "custom-a");
      assert.equal(registry.get("goose").enabled, false);
      assert.equal(registry.get("custom-a").clientCapabilities.fs, true);
      assert.equal(registry.get("custom-a").clientCapabilities.terminal, false);

      const exec = registry.resolveExecution(registry.get("custom-a"));
      assert.equal(exec.installed, true);
      assert.equal(exec.runnable, true);
      assert.equal(exec.resolution, "configured");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("AcpHub integration with Mock ACP Agents", () => {
  let workdir;
  let outsideDir;
  let hub;

  before(() => {
    workdir = mkdtempSync(join(tmpdir(), "acp-hub-work-"));
    outsideDir = mkdtempSync(join(tmpdir(), "acp-hub-out-"));
    writeFileSync(join(workdir, "hello.txt"), "hello-from-workspace", "utf8");
    writeFileSync(join(outsideDir, "secret.txt"), "do-not-read", "utf8");

    hub = new AcpHub({
      inlineConfig: {
        defaultHarness: "alpha",
        harnesses: {
          alpha: {
            displayName: "Mock Alpha",
            command: "node",
            args: [MOCK_AGENT],
            env: { MOCK_AGENT_NAME: "alpha" },
            clientCapabilities: { fs: true, terminal: true },
          },
          beta: {
            displayName: "Mock Beta (Minimal)",
            command: "node",
            args: [MOCK_AGENT],
            env: {
              MOCK_AGENT_NAME: "beta",
              MOCK_LOAD_SESSION: "false",
              MOCK_LIST_SESSIONS: "false",
              MOCK_SUPPORT_SET_MODE: "false",
              MOCK_SUPPORT_ADDITIONAL_DIRS: "false",
            },
          },
        },
      },
    });
  });

  after(async () => {
    await hub?.dispose();
    rmSync(workdir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("probes capabilities, creates sessions on two harnesses, and routes composite IDs", async () => {
    const listed = await hub.listHarnesses({ harness: "alpha", probe: true });
    assert.equal(listed.harnesses.length, 1);
    assert.equal(listed.harnesses[0].connectionStatus, "connected");
    assert.equal(listed.harnesses[0].capabilities.loadSession, true);
    assert.equal(listed.harnesses[0].capabilities.listSessions, true);

    const s1 = await hub.newSession({ harness: "alpha", cwd: workdir });
    const s2 = await hub.newSession({ harness: "beta", cwd: workdir, mode: "plan" });

    assert.match(s1.sessionId, /^alpha:/);
    assert.match(s2.sessionId, /^beta:/);
    assert.ok(
      s2.warnings.some((w) => w.includes('Failed to set mode="plan"')),
      "beta without set_mode should gracefully record warning",
    );

    const r1 = await hub.prompt({ sessionId: s1.sessionId, message: "ping-1" });
    const r2 = await hub.prompt({ sessionId: s2.sessionId, message: "ping-2" });
    const r1b = await hub.prompt({ sessionId: s1.sessionId, message: "ping-1b" });

    assert.match(r1.text, /\[alpha\] turns=1.*msg=ping-1/);
    assert.match(r2.text, /\[beta\] turns=1.*msg=ping-2/);
    assert.match(r1b.text, /\[alpha\] turns=2.*msg=ping-1b/);

    await hub.closeSession(s1.sessionId);
    await hub.closeSession(s2.sessionId);
  });

  test("enforces same-session serial lock while allowing cross-harness concurrency", async () => {
    const sAlpha = await hub.newSession({ harness: "alpha", cwd: workdir });
    const sBeta = await hub.newSession({ harness: "beta", cwd: workdir });

    // Same session concurrent prompts must execute serially
    const [p1, p2] = await Promise.all([
      hub.prompt({ sessionId: sAlpha.sessionId, message: "lock_test:first:120" }),
      hub.prompt({ sessionId: sAlpha.sessionId, message: "lock_test:second:120" }),
    ]);
    const t1 = JSON.parse(p1.text);
    const t2 = JSON.parse(p2.text);
    assert.ok(t2.start >= t1.end - 5, `expected serial execution: t1=${p1.text} t2=${p2.text}`);

    // Cross-harness prompts should overlap in time
    const [pa, pb] = await Promise.all([
      hub.prompt({ sessionId: sAlpha.sessionId, message: "lock_test:a:180" }),
      hub.prompt({ sessionId: sBeta.sessionId, message: "lock_test:b:180" }),
    ]);
    const ta = JSON.parse(pa.text);
    const tb = JSON.parse(pb.text);
    const overlap = Math.min(ta.end, tb.end) - Math.max(ta.start, tb.start);
    assert.ok(overlap > 20, `expected concurrent cross-harness execution, overlap=${overlap}ms`);

    await hub.closeSession(sAlpha.sessionId);
    await hub.closeSession(sBeta.sessionId);
  });

  test("enforces approval_policy across read_only / accept_edits / allow_all and captures elicitations", async () => {
    const s = await hub.newSession({ harness: "alpha", cwd: workdir, approvalPolicy: "read_only" });

    const rRead = await hub.prompt({ sessionId: s.sessionId, message: "perm:read:ReadFile" });
    assert.match(rRead.text, /perm_result:approved:allow-once-id/);
    assert.equal(rRead.deniedPermissions.length, 0);

    const rEditBlocked = await hub.prompt({ sessionId: s.sessionId, message: "perm:edit:EditFile" });
    assert.match(rEditBlocked.text, /perm_result:denied:reject-once-id/);
    assert.equal(rEditBlocked.deniedPermissions.length, 1);
    assert.equal(rEditBlocked.deniedPermissions[0].harness, "alpha");

    const rEditAllowed = await hub.prompt({
      sessionId: s.sessionId,
      message: "perm:edit:EditFile",
      approvalPolicy: "accept_edits",
    });
    assert.match(rEditAllowed.text, /perm_result:approved:allow-once-id/);

    const rDeleteBlocked = await hub.prompt({
      sessionId: s.sessionId,
      message: "perm:delete:RemoveFile",
      approvalPolicy: "accept_edits",
    });
    assert.match(rDeleteBlocked.text, /perm_result:denied:reject-once-id/);
    assert.equal(rDeleteBlocked.deniedPermissions.length, 1);

    const rShellAllowed = await hub.prompt({
      sessionId: s.sessionId,
      message: "perm:execute:Bash",
      approvalPolicy: "allow_all",
    });
    assert.match(rShellAllowed.text, /perm_result:approved:allow-once-id/);

    const rElicit = await hub.prompt({ sessionId: s.sessionId, message: "elicit:Need API key?" });
    assert.equal(rElicit.elicitations.length, 1);
    assert.equal(rElicit.elicitations[0].message, "Need API key?");

    await hub.closeSession(s.sessionId);
  });

  test("gracefully degrades unsupported loadSession / listSessions / additionalDirectories on beta", async () => {
    const sBeta = await hub.newSession({
      harness: "beta",
      cwd: workdir,
      additionalDirectories: [outsideDir],
    });
    assert.ok(
      sBeta.warnings.some((w) => w.includes("additionalDirectories")),
      "expected warning when additionalDirectories unsupported",
    );

    await assert.rejects(
      () => hub.loadSession({ harness: "beta", sessionId: "sess_99", cwd: workdir }),
      /does not advertise ACP "loadSession" capability/,
    );

    const listed = await hub.listSessions({ harness: "beta", includeHistory: true });
    assert.equal(listed.active.length, 1);
    assert.equal(listed.history.length, 0);
    assert.ok(listed.warnings.some((w) => w.includes('session/list')));

    await hub.closeSession(sBeta.sessionId);
  });

  test("gates optional Client fs & terminal proxy by approval_policy and workspace allowlist", async () => {
    const s = await hub.newSession({ harness: "alpha", cwd: workdir, approvalPolicy: "read_only" });

    // Read inside workspace allowed under read_only
    const okRead = await hub.prompt({
      sessionId: s.sessionId,
      message: `fs_read:${join(workdir, "hello.txt")}`,
    });
    assert.equal(okRead.text, "fs_read_ok:hello-from-workspace");

    // Read outside workspace blocked
    const badRead = await hub.prompt({
      sessionId: s.sessionId,
      message: `fs_read:${join(outsideDir, "secret.txt")}`,
    });
    assert.match(badRead.text, /fs_read_err:.*outside allowed workspace/);
    assert.equal(badRead.deniedPermissions.length, 1);

    // Write under read_only blocked
    const outFile = join(workdir, "written.txt");
    const badWrite = await hub.prompt({
      sessionId: s.sessionId,
      message: `fs_write:${outFile}|abc`,
    });
    assert.match(badWrite.text, /fs_write_err:.*denied by approval_policy/);

    // Write under accept_edits succeeds
    const okWrite = await hub.prompt({
      sessionId: s.sessionId,
      message: `fs_write:${outFile}|hello-written`,
      approvalPolicy: "accept_edits",
    });
    assert.equal(okWrite.text, "fs_write_ok");
    assert.equal(readFileSync(outFile, "utf8"), "hello-written");

    // Terminal under accept_edits blocked, under allow_all succeeds
    const badTerm = await hub.prompt({
      sessionId: s.sessionId,
      message: "term:hi-term",
      approvalPolicy: "accept_edits",
    });
    assert.match(badTerm.text, /term_err:.*denied by approval_policy/);

    const okTerm = await hub.prompt({
      sessionId: s.sessionId,
      message: "term:hi-term",
      approvalPolicy: "allow_all",
    });
    assert.equal(okTerm.text, "term_ok:0:hi-term");

    await hub.closeSession(s.sessionId);
  });

  test("handles turn timeout with cancel and recovers cleanly after child process crash", async () => {
    const s = await hub.newSession({ harness: "alpha", cwd: workdir });
    const timed = await hub.prompt({
      sessionId: s.sessionId,
      message: "slow:5000",
      timeoutSeconds: 0.3,
    });
    assert.equal(timed.stopReason, "timeout");
    assert.equal(timed.text, "partial_before_timeout");

    // Trigger crash
    await assert.rejects(
      () => hub.prompt({ sessionId: s.sessionId, message: "crash" }),
      /exited|closed|crash/i,
    );

    // Next session should transparently spawn a fresh child process
    const sRecovered = await hub.newSession({ harness: "alpha", cwd: workdir });
    const rRecovered = await hub.prompt({ sessionId: sRecovered.sessionId, message: "after-crash" });
    assert.match(rRecovered.text, /\[alpha\] turns=1.*msg=after-crash/);

    await hub.closeSession(sRecovered.sessionId);
  });
});

describe("MCP Server end-to-end over stdio", () => {
  test("exposes 7 acp_* tools and completes a full session lifecycle", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "acp-hub-mcp-"));
    const cfgPath = join(workdir, "acp-harnesses.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        defaultHarness: "mock",
        harnesses: {
          mock: {
            displayName: "Mock MCP Harness",
            command: "node",
            args: [MOCK_AGENT],
            env: { MOCK_AGENT_NAME: "mcp-mock" },
          },
        },
      }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_INDEX],
      env: { ...process.env, ACP_HUB_CONFIG: cfgPath },
    });
    const client = new McpClient({ name: "acp-hub-test-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      const toolsRes = await client.listTools();
      const names = toolsRes.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "acp_cancel",
        "acp_close_session",
        "acp_list_harnesses",
        "acp_list_sessions",
        "acp_load_session",
        "acp_new_session",
        "acp_prompt",
      ]);

      const harnessesRes = await client.callTool({
        name: "acp_list_harnesses",
        arguments: { harness: "mock", probe: true },
      });
      assert.equal(harnessesRes.isError, undefined);
      const parsedHarnesses = JSON.parse(harnessesRes.content[0].text);
      assert.equal(parsedHarnesses.harnesses[0].connectionStatus, "connected");

      const createdRes = await client.callTool({
        name: "acp_new_session",
        arguments: {
          harness: "mock",
          cwd: workdir,
          initial_prompt: "hello-mcp",
        },
      });
      assert.equal(createdRes.isError, undefined);
      const firstText = createdRes.content[0].text;
      assert.match(firstText, /\[ACP:mock\]/);
      assert.match(firstText, /\[mcp-mock\] turns=1.*msg=hello-mcp/);

      const sidMatch = firstText.match(/sessionId=([^\s|]+)/);
      assert.ok(sidMatch, "expected composite sessionId in header");
      const sessionId = sidMatch[1];

      const secondRes = await client.callTool({
        name: "acp_prompt",
        arguments: { session_id: sessionId, message: "follow-up" },
      });
      assert.match(secondRes.content[0].text, /turns=2.*msg=follow-up/);

      const closeRes = await client.callTool({
        name: "acp_close_session",
        arguments: { session_id: sessionId },
      });
      assert.equal(JSON.parse(closeRes.content[0].text).closed, true);
    } finally {
      await client.close().catch(() => {});
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
