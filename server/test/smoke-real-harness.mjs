import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpHub } from "../acp-hub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const requestedHarness = process.env.HARNESS || null;

const hub = new AcpHub();

try {
  console.log("=== 1. 检测本机已配置的 ACP Harnesses ===");
  const overview = await hub.listHarnesses();
  for (const h of overview.harnesses) {
    console.log(
      `- ${h.id} (${h.displayName}): installed=${h.installed} runnable=${h.runnable} resolution=${h.resolution} cmd="${h.command}"`,
    );
  }

  const target = requestedHarness
    ? overview.harnesses.find((h) => h.id === requestedHarness)
    : overview.harnesses.find((h) => h.enabled && h.runnable);

  if (!target) {
    console.error(
      requestedHarness
        ? `指定的 Harness "${requestedHarness}" 不存在或未就绪。`
        : "未检测到任何已安装可运行的真实 ACP Harness，请先安装至少一个适配器或 CLI。",
    );
    process.exit(1);
  }

  console.log(`\n=== 2. 主动探测目标 Harness: ${target.id} ===`);
  const probed = await hub.listHarnesses({ harness: target.id, probe: true });
  const info = probed.harnesses[0];
  console.log(JSON.stringify(info, null, 2));
  if (info.connectionStatus !== "connected") {
    throw new Error(`Probe failed for ${target.id}: ${info.probeError}`);
  }

  console.log(`\n=== 3. 创建只读会话并执行一轮问答 (${target.id}) ===`);
  const session = await hub.newSession({
    harness: target.id,
    cwd: repoRoot,
    approvalPolicy: "read_only",
  });
  console.log("Created session:", JSON.stringify(session, null, 2));

  const reply = await hub.prompt({
    sessionId: session.sessionId,
    message: "Please reply with exactly one short sentence confirming you can read this prompt. Do not modify any files.",
    approvalPolicy: "read_only",
    timeoutSeconds: 90,
  });
  console.log("\nTurn result:", JSON.stringify({
    sessionId: reply.sessionId,
    harness: reply.harness,
    stopReason: reply.stopReason,
    toolCalls: reply.toolCalls,
    deniedPermissions: reply.deniedPermissions,
    warnings: reply.warnings,
    text: reply.text,
  }, null, 2));

  console.log("\n=== 4. 关闭会话 ===");
  const closed = await hub.closeSession(session.sessionId);
  console.log("Closed:", closed);
} finally {
  await hub.dispose();
}
