import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

const state = {
  snapshot: null,
  filter: "all",
  refreshing: false,
  pendingByHarness: new Map(),
  copiedHarnessId: null,
  fatalError: null,
};

const els = {
  configPath: document.getElementById("configPath"),
  refreshBtn: document.getElementById("refreshBtn"),
  banners: document.getElementById("banners"),
  statsGrid: document.getElementById("statsGrid"),
  filterTabs: document.getElementById("filterTabs"),
  cardsContainer: document.getElementById("cardsContainer"),
  toast: document.getElementById("toast"),
};

let toastTimer = null;
let copyResetTimer = null;

function showToast(message, kind = "info") {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = `toast show${kind === "success" ? " toast-success" : kind === "error" ? " toast-error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 3200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractToolError(result, fallback = "操作失败") {
  if (result?.content?.length) {
    const text = result.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return fallback;
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below when sandboxed iframe restricts async Clipboard API
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function getFilteredHarnesses(harnesses) {
  switch (state.filter) {
    case "enabled":
      return harnesses.filter((h) => h.enabled);
    case "installed":
      return harnesses.filter((h) => h.installed || h.runnable);
    case "disabled":
      return harnesses.filter((h) => !h.enabled);
    default:
      return harnesses;
  }
}

function formatCapabilities(capabilities) {
  if (!capabilities) return [];
  const tags = [];
  if (capabilities.loadSession) tags.push("会话恢复");
  if (capabilities.listSessions) tags.push("历史列表");
  if (capabilities.closeSession) tags.push("关闭会话");
  if (capabilities.resumeSession) tags.push("会话续接");
  if (capabilities.additionalDirectories) tags.push("多目录");
  if (capabilities.imagePrompt) tags.push("图像输入");
  if (Array.isArray(capabilities.authMethods) && capabilities.authMethods.length > 0) {
    tags.push(`认证方式(${capabilities.authMethods.length})`);
  }
  return tags;
}

function renderEnvBadge(h) {
  if (h.installed) {
    return `<span class="badge badge-success">本机已就绪</span>`;
  }
  if (h.runnable && h.resolution === "npx-fallback") {
    return `<span class="badge badge-info">NPX 兜底</span>`;
  }
  return `<span class="badge badge-warning">未安装</span>`;
}

function renderConnBadge(h) {
  if (h.connectionStatus === "connected") {
    return `<span class="badge badge-success"><span class="dot"></span>已连接</span>`;
  }
  if (h.connectionStatus === "connecting") {
    return `<span class="badge badge-info"><span class="dot"></span>连接中</span>`;
  }
  if (h.connectionStatus === "error") {
    return `<span class="badge badge-danger"><span class="dot"></span>连接异常</span>`;
  }
  return `<span class="badge">待机</span>`;
}

function renderBanners(snapshot) {
  const banners = [];
  if (state.fatalError) {
    banners.push(
      `<div class="banner banner-danger"><strong>连接异常：</strong><span>${escapeHtml(state.fatalError)}</span></div>`,
    );
  }
  if (snapshot?.configWarning) {
    banners.push(
      `<div class="banner banner-danger"><strong>配置文件告警：</strong><span>${escapeHtml(snapshot.configWarning)}（为防止覆盖损坏，请先修复该 JSON 文件后再修改开关）</span></div>`,
    );
  }
  const defaultEntry = snapshot?.harnesses?.find((h) => h.isDefault);
  if (defaultEntry && !defaultEntry.enabled) {
    banners.push(
      `<div class="banner banner-warning"><strong>提示：</strong><span>当前默认 Harness「${escapeHtml(defaultEntry.displayName)} (${escapeHtml(defaultEntry.id)})」已被禁用。请重新启用它，或将其他已启用的 Harness 设为默认。</span></div>`,
    );
  }
  els.banners.innerHTML = banners.join("");
}

function renderStats(harnesses) {
  const total = harnesses.length;
  const enabled = harnesses.filter((h) => h.enabled).length;
  const ready = harnesses.filter((h) => h.installed || h.runnable).length;
  const connected = harnesses.filter((h) => h.connectionStatus === "connected").length;

  const items = [
    { label: "全部 Harness", value: total },
    { label: "已启用", value: enabled },
    { label: "本机可用", value: ready },
    { label: "已连接", value: connected },
  ];
  els.statsGrid.innerHTML = items
    .map(
      (item) => `
      <div class="stat-card">
        <div class="stat-label">${item.label}</div>
        <div class="stat-value">${item.value}</div>
      </div>`,
    )
    .join("");
}

function renderFilterTabs(harnesses) {
  const tabs = [
    { id: "all", label: "全部", count: harnesses.length },
    { id: "enabled", label: "已启用", count: harnesses.filter((h) => h.enabled).length },
    {
      id: "installed",
      label: "本机可用",
      count: harnesses.filter((h) => h.installed || h.runnable).length,
    },
    { id: "disabled", label: "已禁用", count: harnesses.filter((h) => !h.enabled).length },
  ];

  els.filterTabs.innerHTML = tabs
    .map(
      (tab) => `
      <button
        type="button"
        role="tab"
        aria-selected="${state.filter === tab.id ? "true" : "false"}"
        class="filter-tab${state.filter === tab.id ? " active" : ""}"
        data-filter="${tab.id}"
      >
        <span>${tab.label}</span>
        <span class="tab-count">${tab.count}</span>
      </button>`,
    )
    .join("");
}

function renderCard(h) {
  const pendingAction = state.pendingByHarness.get(h.id) ?? null;
  const isBusy = Boolean(pendingAction);
  const caps = formatCapabilities(h.capabilities);
  const canProbe = h.enabled && h.runnable && !isBusy;
  const canSetDefault = h.enabled && !h.isDefault && !isBusy;
  const showDisconnect =
    h.connectionStatus === "connected" || h.connectionStatus === "error";

  const detailRows = [];
  if (h.installed || h.runnable) {
    if (h.command) {
      detailRows.push(`
        <div class="kv-row">
          <span class="kv-label">启动命令</span>
          <span class="kv-code" title="${escapeHtml(h.command)}">${escapeHtml(h.command)}</span>
        </div>`);
    }
    if (h.executable) {
      detailRows.push(`
        <div class="kv-row">
          <span class="kv-label">本机路径</span>
          <span class="kv-code" title="${escapeHtml(h.executable)}">${escapeHtml(h.executable)}</span>
        </div>`);
    }
  } else if (h.installHint) {
    const isCopied = state.copiedHarnessId === h.id;
    detailRows.push(`
      <div class="install-box">
        <code class="install-cmd">${escapeHtml(h.installHint)}</code>
        <button
          type="button"
          class="btn btn-sm"
          data-action="copy-install"
          data-harness="${escapeHtml(h.id)}"
        >${isCopied ? "已复制 ✓" : "复制"}</button>
      </div>`);
  }

  if (h.agentInfo) {
    const agentLabel = [h.agentInfo.title || h.agentInfo.name, h.agentInfo.version]
      .filter(Boolean)
      .join(" v");
    if (agentLabel) {
      detailRows.push(`
        <div class="kv-row">
          <span class="kv-label">Agent 信息</span>
          <span class="kv-code" title="${escapeHtml(agentLabel)}">${escapeHtml(agentLabel)}</span>
        </div>`);
    }
  }

  if (caps.length > 0) {
    detailRows.push(`
      <div class="caps-wrap">
        ${caps.map((c) => `<span class="cap-chip">${escapeHtml(c)}</span>`).join("")}
      </div>`);
  }

  const cardClasses = [
    "card",
    h.isDefault ? "is-default" : "",
    !h.enabled ? "is-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <article class="${cardClasses}" data-harness-card="${escapeHtml(h.id)}">
      <div class="card-head">
        <div class="card-title-wrap">
          <div class="card-title-row">
            <h2 class="card-name">${escapeHtml(h.displayName)}</h2>
            <span class="card-id">${escapeHtml(h.id)}</span>
            <span class="badge">${h.isBuiltin ? "内置" : "自定义"}</span>
            ${h.isDefault ? `<span class="badge badge-info">默认</span>` : ""}
          </div>
          ${h.description ? `<p class="card-desc">${escapeHtml(h.description)}</p>` : ""}
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked="${h.enabled ? "true" : "false"}"
          aria-label="${h.enabled ? "禁用" : "启用"} ${escapeHtml(h.displayName)}"
          title="${h.enabled ? "点击禁用" : "点击启用"}"
          data-action="toggle-enabled"
          data-harness="${escapeHtml(h.id)}"
          data-next-enabled="${h.enabled ? "false" : "true"}"
          ${isBusy ? "disabled" : ""}
        ></button>
      </div>

      <div class="badges-row">
        ${h.enabled ? `<span class="badge badge-success">已启用</span>` : `<span class="badge">已禁用</span>`}
        ${renderEnvBadge(h)}
        ${renderConnBadge(h)}
        ${
          h.activeSessionCount > 0
            ? `<span class="badge badge-info">活跃会话 ${h.activeSessionCount}</span>`
            : ""
        }
      </div>

      ${detailRows.length > 0 ? `<div class="detail-box">${detailRows.join("")}</div>` : ""}

      ${
        h.probeError
          ? `<div class="error-box"><strong>探测/连接错误：</strong>${escapeHtml(h.probeError)}</div>`
          : ""
      }

      <div class="card-actions">
        <button
          type="button"
          class="btn btn-sm${h.isDefault ? " btn-primary" : ""}"
          data-action="set-default"
          data-harness="${escapeHtml(h.id)}"
          ${canSetDefault ? "" : "disabled"}
          title="${
            h.isDefault
              ? "已是当前默认 Harness"
              : !h.enabled
                ? "请先启用后再设为默认"
                : "设为默认 Harness"
          }"
        >
          ${
            pendingAction === "set-default"
              ? "设置中..."
              : h.isDefault
                ? "当前默认"
                : "设为默认"
          }
        </button>

        <button
          type="button"
          class="btn btn-sm"
          data-action="probe"
          data-harness="${escapeHtml(h.id)}"
          ${canProbe ? "" : "disabled"}
          title="${
            !h.enabled
              ? "请先启用后再探测"
              : !h.runnable
                ? "本机未安装此 Harness CLI"
                : "执行 ACP initialize 握手探测能力"
          }"
        >
          ${pendingAction === "probe" ? "探测中..." : "探测连接"}
        </button>

        ${
          showDisconnect
            ? `<button
                type="button"
                class="btn btn-sm btn-danger"
                data-action="disconnect"
                data-harness="${escapeHtml(h.id)}"
                ${isBusy ? "disabled" : ""}
              >${pendingAction === "disconnect" ? "断开中..." : "断开连接"}</button>`
            : ""
        }
      </div>
    </article>
  `;
}

function render() {
  const snapshot = state.snapshot;
  els.refreshBtn.disabled = state.refreshing;
  els.refreshBtn.textContent = state.refreshing ? "刷新中..." : "刷新检测";

  if (!snapshot) {
    renderBanners(null);
    els.configPath.textContent = state.fatalError ? "未连接" : "加载中...";
    els.statsGrid.innerHTML = "";
    els.filterTabs.innerHTML = "";
    els.cardsContainer.className = "loading-box";
    els.cardsContainer.textContent = state.fatalError
      ? "无法加载 ACP Hub 状态，请点击右上角「刷新检测」重试。"
      : "正在加载 ACP Harness 状态...";
    return;
  }

  const cfgPath = snapshot.configPath || "(内存配置)";
  els.configPath.textContent = cfgPath;
  els.configPath.title = cfgPath;

  const harnesses = Array.isArray(snapshot.harnesses) ? snapshot.harnesses : [];
  renderBanners(snapshot);
  renderStats(harnesses);
  renderFilterTabs(harnesses);

  const visible = getFilteredHarnesses(harnesses);
  if (visible.length === 0) {
    els.cardsContainer.className = "empty-state";
    els.cardsContainer.textContent = "当前筛选条件下没有匹配的 ACP Harness。";
    return;
  }

  els.cardsContainer.className = "cards-grid";
  els.cardsContainer.innerHTML = visible.map(renderCard).join("");
}

const app = new App({ name: "ACP Hub Dashboard", version: "2.0.0" }, {});

async function callAppTool(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result?.isError) {
    throw new Error(extractToolError(result, `调用 ${name} 失败`));
  }
  return result;
}

async function refreshState({ silent = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  state.fatalError = null;
  render();
  try {
    const result = await callAppTool("acp_ui_get_state", {});
    if (result?.structuredContent) {
      state.snapshot = result.structuredContent;
    }
    if (!silent) {
      showToast("已刷新本机 Harness 状态", "success");
    }
  } catch (err) {
    state.fatalError = err.message;
    showToast(err.message, "error");
  } finally {
    state.refreshing = false;
    render();
  }
}

async function handleHarnessAction(action, harnessId, extra = {}) {
  if (action === "copy-install") {
    const entry = state.snapshot?.harnesses?.find((h) => h.id === harnessId);
    if (!entry?.installHint) return;
    const ok = await copyText(entry.installHint);
    if (ok) {
      state.copiedHarnessId = harnessId;
      render();
      showToast(`已复制 ${entry.displayName} 安装命令`, "success");
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        state.copiedHarnessId = null;
        render();
      }, 1800);
    } else {
      showToast("当前环境限制自动复制，请手动选中命令复制", "error");
    }
    return;
  }

  if (state.pendingByHarness.has(harnessId)) return;
  state.pendingByHarness.set(harnessId, action);
  render();

  try {
    if (action === "toggle-enabled") {
      const nextEnabled = Boolean(extra.nextEnabled);
      const res = await callAppTool("acp_ui_set_harness_enabled", {
        harness: harnessId,
        enabled: nextEnabled,
      });
      if (res?.structuredContent) {
        state.snapshot = res.structuredContent;
      }
      showToast(
        nextEnabled ? `已启用 ${harnessId}` : `已禁用 ${harnessId} 并释放连接`,
        "success",
      );
    } else if (action === "set-default") {
      const res = await callAppTool("acp_ui_set_default_harness", { harness: harnessId });
      if (res?.structuredContent) {
        state.snapshot = res.structuredContent;
      }
      showToast(`已将 ${harnessId} 设为默认 Harness`, "success");
    } else if (action === "probe") {
      const res = await callAppTool("acp_ui_probe_harness", { harness: harnessId });
      if (res?.structuredContent) {
        state.snapshot = res.structuredContent;
      }
      const probed = res?.structuredContent?.probedHarness;
      if (probed?.probeError) {
        showToast(`${harnessId} 探测失败：${probed.probeError}`, "error");
      } else {
        showToast(`${harnessId} 探测成功，连接已就绪`, "success");
      }
    } else if (action === "disconnect") {
      const res = await callAppTool("acp_ui_disconnect_harness", { harness: harnessId });
      if (res?.structuredContent) {
        state.snapshot = res.structuredContent;
      }
      const closed = res?.structuredContent?.disconnectResult?.closedSessionCount ?? 0;
      showToast(
        closed > 0
          ? `已断开 ${harnessId}（同时关闭 ${closed} 个活跃会话）`
          : `已断开 ${harnessId} 连接`,
        "success",
      );
    }
  } catch (err) {
    showToast(err.message || "操作失败", "error");
  } finally {
    state.pendingByHarness.delete(harnessId);
    render();
  }
}

els.refreshBtn.addEventListener("click", () => {
  refreshState({ silent: false });
});

els.filterTabs.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  state.filter = btn.dataset.filter || "all";
  render();
});

els.cardsContainer.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const harnessId = target.dataset.harness;
  if (!action || !harnessId) return;
  handleHarnessAction(action, harnessId, {
    nextEnabled: target.dataset.nextEnabled === "true",
  });
});

// Register lifecycle handlers BEFORE connect() so no initial notification is missed.
app.ontoolinput = () => {
  if (!state.snapshot) {
    render();
  }
};

app.ontoolresult = (result) => {
  if (result?.isError) {
    state.fatalError = extractToolError(result, "加载面板状态失败");
    render();
    return;
  }
  if (result?.structuredContent && Array.isArray(result.structuredContent.harnesses)) {
    state.fatalError = null;
    state.snapshot = result.structuredContent;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

render();

try {
  await app.connect();
  applyHostContext(app.getHostContext());
  // Fallback fetch if host launched the view without pushing an initial tool result yet.
  setTimeout(() => {
    if (!state.snapshot && !state.refreshing) {
      refreshState({ silent: true });
    }
  }, 250);
} catch (err) {
  state.fatalError = `MCP App 握手失败：${err.message}`;
  render();
}
