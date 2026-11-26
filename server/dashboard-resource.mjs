import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DASHBOARD_HTML } from "./generated/dashboard-html.mjs";

export const DASHBOARD_RESOURCE_URI = "ui://acp-hub/dashboard.html";
export const DASHBOARD_MIME_TYPE = "text/html;profile=mcp-app";

const DASHBOARD_ENTRY_META = Object.freeze({
  ui: {
    resourceUri: DASHBOARD_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  "com.google.antigravity/ui": {
    entrypoints: [{ type: "global", title: "ACP Hub" }],
  },
});

const APP_ONLY_META = Object.freeze({
  ui: {
    visibility: ["app"],
  },
});

export function loadDashboardHtml() {
  const overridePath = process.env.ACP_HUB_DASHBOARD_HTML;
  if (overridePath && existsSync(overridePath)) {
    return readFileSync(overridePath, "utf8");
  }
  return DASHBOARD_HTML;
}

function formatDashboardSummary(snapshot) {
  const total = snapshot.harnesses.length;
  const enabledCount = snapshot.harnesses.filter((h) => h.enabled).length;
  const installedCount = snapshot.harnesses.filter((h) => h.installed).length;
  const connectedCount = snapshot.harnesses.filter(
    (h) => h.connectionStatus === "connected",
  ).length;

  const lines = [
    `ACP Hub Dashboard (${enabledCount}/${total} enabled, ${installedCount} installed, ${connectedCount} connected)`,
    `defaultHarness=${snapshot.defaultHarness} | configPath=${snapshot.configPath ?? "(in-memory)"}`,
  ];
  if (snapshot.configWarning) {
    lines.push(`warning: ${snapshot.configWarning}`);
  }
  for (const h of snapshot.harnesses) {
    const flags = [
      h.enabled ? "enabled" : "disabled",
      h.installed ? "installed" : h.runnable ? "npx" : "missing",
      h.connectionStatus,
      h.isDefault ? "default" : null,
    ].filter(Boolean);
    lines.push(`- ${h.id} (${h.displayName}): ${flags.join(", ")}`);
  }
  return lines.join("\n");
}

function uiToolError(hub, err, harnessId = null) {
  const stderr = hub.recentStderr(harnessId);
  const detail = stderr ? `${err.message}\n\nRecent ACP stderr:\n${stderr}` : err.message;
  return {
    isError: true,
    content: [{ type: "text", text: detail }],
  };
}

export function registerDashboardApp(server, hub) {
  server.registerResource(
    "acp-hub-dashboard",
    DASHBOARD_RESOURCE_URI,
    {
      title: "ACP Hub Harness Manager",
      description:
        "Interactive global dashboard for viewing and controlling configured ACP harnesses.",
      mimeType: DASHBOARD_MIME_TYPE,
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
          mimeType: DASHBOARD_MIME_TYPE,
          text: loadDashboardHtml(),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "acp_open_dashboard",
    {
      title: "ACP Hub",
      description:
        "Open the ACP Hub Harness management dashboard and return a live snapshot of all configured harnesses, local installation status, and connection states.",
      inputSchema: {},
      _meta: DASHBOARD_ENTRY_META,
    },
    async () => {
      try {
        const snapshot = await hub.listHarnesses({ probe: false });
        return {
          content: [{ type: "text", text: formatDashboardSummary(snapshot) }],
          structuredContent: snapshot,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_get_state",
    {
      title: "Refresh ACP Hub Dashboard State",
      description: "App-only tool for the dashboard UI to refresh harness status without probing.",
      inputSchema: {},
      _meta: APP_ONLY_META,
    },
    async () => {
      try {
        const snapshot = await hub.listHarnesses({ probe: false });
        return {
          content: [{ type: "text", text: formatDashboardSummary(snapshot) }],
          structuredContent: snapshot,
        };
      } catch (err) {
        return uiToolError(hub, err);
      }
    },
  );

  server.registerTool(
    "acp_ui_set_harness_enabled",
    {
      title: "Toggle ACP Harness Enabled State",
      description:
        "App-only tool for the dashboard UI to enable or disable a harness in acp-harnesses.json and disconnect it immediately when disabled.",
      inputSchema: {
        harness: z.string().min(1).describe("Target harness ID."),
        enabled: z.boolean().describe("Whether the harness should be enabled."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const snapshot = await hub.setHarnessEnabled(args.harness, args.enabled);
        return {
          content: [
            {
              type: "text",
              text: `Harness "${args.harness}" ${args.enabled ? "enabled" : "disabled"}.`,
            },
          ],
          structuredContent: snapshot,
        };
      } catch (err) {
        return uiToolError(hub, err, args.harness);
      }
    },
  );

  server.registerTool(
    "acp_ui_set_default_harness",
    {
      title: "Set Default ACP Harness",
      description:
        "App-only tool for the dashboard UI to update defaultHarness in acp-harnesses.json.",
      inputSchema: {
        harness: z.string().min(1).describe("Enabled harness ID to set as default."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const snapshot = await hub.setDefaultHarness(args.harness);
        return {
          content: [
            {
              type: "text",
              text: `Default ACP harness set to "${args.harness}".`,
            },
          ],
          structuredContent: snapshot,
        };
      } catch (err) {
        return uiToolError(hub, err, args.harness);
      }
    },
  );

  server.registerTool(
    "acp_ui_probe_harness",
    {
      title: "Probe Single ACP Harness",
      description:
        "App-only tool for the dashboard UI to run an ACP initialize handshake against a single harness.",
      inputSchema: {
        harness: z.string().min(1).describe("Target harness ID to probe."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const probed = await hub.listHarnesses({ harness: args.harness, probe: true });
        const probedItem = probed.harnesses[0] ?? null;
        const snapshot = await hub.listHarnesses({ probe: false });
        if (probedItem) {
          snapshot.harnesses = snapshot.harnesses.map((item) =>
            item.id === probedItem.id ? probedItem : item,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: probedItem?.probeError
                ? `Probe failed for "${args.harness}": ${probedItem.probeError}`
                : `Probed "${args.harness}": status=${probedItem?.connectionStatus ?? "unknown"}`,
            },
          ],
          structuredContent: {
            ...snapshot,
            probedHarness: probedItem,
          },
        };
      } catch (err) {
        return uiToolError(hub, err, args.harness);
      }
    },
  );

  server.registerTool(
    "acp_ui_disconnect_harness",
    {
      title: "Disconnect ACP Harness",
      description:
        "App-only tool for the dashboard UI to disconnect a running harness connection and close its active sessions.",
      inputSchema: {
        harness: z.string().min(1).describe("Target harness ID to disconnect."),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const disconnectResult = await hub.disconnectHarness(args.harness);
        const snapshot = await hub.listHarnesses({ probe: false });
        return {
          content: [
            {
              type: "text",
              text: `Disconnected "${args.harness}" (closed ${disconnectResult.closedSessionCount} active sessions).`,
            },
          ],
          structuredContent: {
            ...snapshot,
            disconnectResult,
          },
        };
      } catch (err) {
        return uiToolError(hub, err, args.harness);
      }
    },
  );
}
