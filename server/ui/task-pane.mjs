import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

const ToggleAuxPaneResultSchema = z
  .object({
    isError: z.boolean().optional(),
  })
  .passthrough();

const rootEl = document.getElementById("root");
const toastEl = document.getElementById("toast");

const CALL_TIMEOUT_MS = 15_000;
const STREAM_TICK_MS = 32;

const STATUS_LABELS = {
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const POLICY_LABELS = {
  interactive: "面板审批",
  interactive_edits: "面板审批（本轮放行编辑）",
  read_only: "只读",
  accept_edits: "允许编辑",
  allow_all: "全放行",
  reject_all: "全部拒绝",
};

const ACTION_LABELS = {
  edit: { label: "改", cls: "file-act-edit" },
  read: { label: "读", cls: "file-act-read" },
  delete: { label: "删", cls: "file-act-delete" },
  other: { label: "触", cls: "file-act-other" },
};

const state = {
  workspace: null,
  activeTaskId: null,
  activeTask: null,
  lastSeq: 0,
  filter: "all", // all | active
  openDrawer: null, // null | "plan" | "files"
  hostCaps: {},
  contextAttachedTaskId: null,
  pendingActions: new Set(),
  expandedDetails: new Map(),
  // Per-turn smooth streaming state: key = `${taskId}:${turnIndex}`
  // { textShownLen, thoughtShownLen, wasStreaming, settledInstant }
  turnStreams: new Map(),
  streamTimer: null,
  // Tracks whether user manually scrolled up inside a thought or assistant body container
  thoughtUserScrolled: new Map(),
  bodyUserScrolled: new Map(),
  expandedCards: new Set(),
  codeBlocksByKey: new Map(),
  codeBlockSeq: 0,
  pollTimer: null,
  pollInFlight: false,
  actionChain: Promise.resolve(),
  toastTimer: null,
  shellMounted: false,
  renderedTaskId: null,
  lastApprovalsSig: "",
};

const dom = {
  topbar: null,
  taskHeader: null,
  stickyBarWrap: null,
  stickyBar: null,
  stickyDrawer: null,
  stickyApprovals: null,
  scroll: null,
  handoffBar: null,
  composerInput: null,
  policySelect: null,
  sendBtn: null,
  composerHint: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toastEl.classList.remove("visible");
  }, 2600);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback for sandboxed iframes without Clipboard API permission
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function formatDuration(startedAt, finishedAt = null) {
  if (!startedAt) return "";
  const end = finishedAt ?? Date.now();
  const sec = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function toFileUri(filePath, cwd = "") {
  if (!filePath || typeof filePath !== "string") return "";
  let candidate = filePath.trim();
  if (!candidate) return "";

  const isWinAbs = /^[a-zA-Z]:[/\\]/.test(candidate);
  const isUnc = /^\\\\[^\\]+\\[^\\]+/.test(candidate);
  const isPosixAbs = candidate.startsWith("/");

  if (!isWinAbs && !isUnc && !isPosixAbs && cwd) {
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[/\\]+$/, "");
    candidate = `${base}${sep}${candidate.replace(/^[/\\]+/, "")}`;
  }

  // Windows UNC path: \\server\share\file -> file://server/share/file
  if (/^\\\\[^\\]+\\[^\\]+/.test(candidate)) {
    const withoutPrefix = candidate.slice(2).replaceAll("\\", "/");
    const [host, ...parts] = withoutPrefix.split("/");
    return `file://${host}/${parts.map((s) => encodeURIComponent(s)).join("/")}`;
  }

  const normalized = candidate.replaceAll("\\", "/");
  // Windows drive letter path: C:/foo/bar -> file:///C:/foo/bar
  if (/^[a-zA-Z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const rest = normalized
      .slice(2)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `file:///${drive}${rest}`;
  }
  const encoded = normalized
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

function isEditKind(approval) {
  const kind = String(approval?.kind ?? "").toLowerCase();
  if (kind === "edit") return true;
  if (kind && kind !== "other") return false;
  const name = String(approval?.toolName ?? "").toLowerCase();
  return /^(edit|edit_file|write_file|write_text_file|create_file|multi_edit|patch|apply_patch|replace|str_replace)/.test(
    name,
  );
}

function renderInlineMarkdown(raw) {
  let text = escapeHtml(raw);
  const inlineCodes = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) =>
      `<a href="${url}" data-ext-url="${url}" rel="noopener noreferrer">${label}</a>`,
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  text = text.replace(/\u0000IC(\d+)\u0000/g, (_, idx) => inlineCodes[Number(idx)] ?? "");
  return text;
}

function renderMarkdown(source) {
  if (!source || !source.trim()) return "";
  const blocks = [];
  let normalized = String(source).replace(/\r\n/g, "\n");

  // Auto-close an unclosed trailing code fence during streaming so partial blocks render cleanly.
  const fenceMatches = normalized.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    normalized += "\n```";
  }

  const withoutCode = normalized.replace(
    /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      state.codeBlockSeq += 1;
      const codeKey = `cb_${state.codeBlockSeq}`;
      state.codeBlocksByKey.set(codeKey, code);
      if (state.codeBlocksByKey.size > 200) {
        const oldestKey = state.codeBlocksByKey.keys().next().value;
        state.codeBlocksByKey.delete(oldestKey);
      }
      const tokenIdx = blocks.length;
      blocks.push(
        `<div class="md-code-wrap"><div class="md-code-head"><span>${escapeHtml(
          lang || "text",
        )}</span><button type="button" class="btn btn-sm btn-ghost" data-copy-code="${codeKey}">复制</button></div><pre><code>${escapeHtml(
          code,
        )}</code></pre></div>`,
      );
      return `\n\u0000BLK${tokenIdx}\u0000\n`;
    },
  );

  const lines = withoutCode.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const blkMatch = trimmed.match(/^\u0000BLK(\d+)\u0000$/);
    if (blkMatch) {
      out.push(blocks[Number(blkMatch[1])] ?? "");
      i += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInlineMarkdown(quoteLines.join("\n")).replace(/\n/g, "<br />")}</blockquote>`);
      continue;
    }

    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = parseRow(lines[i]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        bodyRows.push(parseRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headers
        .map((h) => `<th>${renderInlineMarkdown(h)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => `<td>${renderInlineMarkdown(row[idx] ?? "")}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\u0000BLK\d+\u0000$/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith(">") &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInlineMarkdown(paraLines.join("\n")).replace(/\n/g, "<br />")}</p>`);
  }

  return out.join("");
}

function renderPreviewBlock(preview, fallbackSummary = "") {
  if (!preview) {
    if (!fallbackSummary) return "";
    return `<pre class="preview-pre">${escapeHtml(fallbackSummary)}</pre>`;
  }
  if (preview.type === "command") {
    return `<pre class="preview-pre">$ ${escapeHtml(preview.command)}</pre>`;
  }
  if (preview.type === "diff") {
    return `<div class="diff-grid">${
      preview.oldText
        ? `<pre class="preview-pre diff-del">- ${escapeHtml(preview.oldText)}</pre>`
        : ""
    }${
      preview.newText
        ? `<pre class="preview-pre diff-add">+ ${escapeHtml(preview.newText)}</pre>`
        : ""
    }</div>`;
  }
  if (preview.type === "patch") {
    return `<pre class="preview-pre">${escapeHtml(preview.patch)}</pre>`;
  }
  return `<pre class="preview-pre">${escapeHtml(preview.content ?? fallbackSummary)}</pre>`;
}

function buildHandoffText(task) {
  const lastTurn = task.turns[task.turns.length - 1] ?? null;
  const lines = [
    `以下是我从右侧「ACP 任务台」回传的外部 Agent 任务结果（可基于此继续后续工作）：`,
    `- Harness：${task.harnessDisplayName} (${task.harness})`,
    `- 任务：${task.title}`,
    `- 会话 ID：\`${task.sessionId}\`（任务 ID：\`${task.taskId}\`）`,
    `- 状态：${STATUS_LABELS[task.status] ?? task.status}${task.stopReason ? ` (${task.stopReason})` : ""}`,
  ];
  if (task.files?.length) {
    lines.push(
      `- 涉及文件（${task.files.length}）：`,
      ...task.files.slice(0, 20).map((f) => `  - [${f.actions.join("/")}] \`${f.displayPath}\``),
    );
  }
  if (lastTurn?.text) {
    lines.push("", "### 任务结论", "", lastTurn.text);
  } else if (task.error) {
    lines.push("", `### 错误信息`, "", task.error);
  }
  return lines.join("\n");
}

function getLatestPlan(task) {
  if (!task?.turns?.length) return null;
  for (let i = task.turns.length - 1; i >= 0; i -= 1) {
    if (task.turns[i].plan && task.turns[i].plan.length > 0) {
      return task.turns[i].plan;
    }
  }
  return null;
}

/**
 * Split Markdown into top-level blocks (keeping fenced code blocks intact) so
 * already-completed blocks stay pinned in the DOM without re-rendering/flickering.
 */
function splitMarkdownBlocks(source) {
  if (!source) return [];
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let current = [];
  let inFence = false;

  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined) blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && trimmed === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Compute adaptive per-tick chunk advance for smooth LLM-style streaming.
 * Snaps lightly to whitespace / punctuation boundaries so text flows out in
 * natural readable slices rather than jarring huge jumps.
 */
function advanceStreamCursor(fullText, currentLen, isDone) {
  const total = fullText.length;
  if (currentLen >= total) return total;
  const backlog = total - currentLen;
  // Smooth adaptive velocity: gentle on small deltas, catches up swiftly on large deltas or turn finish
  const rawStep = isDone
    ? Math.max(12, Math.ceil(backlog / 3))
    : Math.max(3, Math.min(36, Math.ceil(backlog / 7)));
  let next = Math.min(total, currentLen + rawStep);
  if (next < total) {
    // Prefer landing cleanly on a space, newline, or CJK/ASCII punctuation within +6 chars
    const lookahead = fullText.slice(next, Math.min(total, next + 6));
    const boundary = lookahead.search(/[\s，。！？；：、,.!?;:\n]/);
    if (boundary > 0) {
      next += boundary + 1;
    }
  }
  return Math.min(total, next);
}

function getOrInitTurnStream(taskId, turn) {
  const key = `${taskId}:${turn.turnIndex}`;
  const isTurnActive = turn.status === "running" || turn.status === "waiting_approval";
  let st = state.turnStreams.get(key);
  if (!st) {
    // Historical already-completed turns render instantly without replaying typewriter animation.
    st = {
      textShownLen: isTurnActive ? 0 : (turn.text ?? "").length,
      thoughtShownLen: isTurnActive ? 0 : (turn.thought ?? "").length,
      wasStreaming: isTurnActive,
    };
    state.turnStreams.set(key, st);
  } else if (isTurnActive) {
    st.wasStreaming = true;
  }
  return st;
}

function hasPendingSmoothStream(task) {
  if (!task?.turns?.length) return false;
  for (const turn of task.turns) {
    const key = `${task.taskId}:${turn.turnIndex}`;
    const st = state.turnStreams.get(key);
    if (!st) continue;
    const textTarget = (turn.text ?? "").length;
    const thoughtTarget = (turn.thought ?? "").length;
    if (st.textShownLen < textTarget || st.thoughtShownLen < thoughtTarget) {
      return true;
    }
  }
  return false;
}

function ensureStreamLoop() {
  if (state.streamTimer) return;
  if (!hasPendingSmoothStream(state.activeTask)) return;
  state.streamTimer = setInterval(() => {
    const task = state.activeTask;
    if (!task || !hasPendingSmoothStream(task)) {
      clearInterval(state.streamTimer);
      state.streamTimer = null;
      return;
    }
    const scrollEl = dom.scroll;
    const wasNearBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 64;

    for (const turn of task.turns) {
      const key = `${task.taskId}:${turn.turnIndex}`;
      const st = state.turnStreams.get(key);
      if (!st) continue;
      const isTurnActive = turn.status === "running" || turn.status === "waiting_approval";
      const thoughtTarget = turn.thought ?? "";
      const textTarget = turn.text ?? "";
      let changed = false;

      if (st.thoughtShownLen < thoughtTarget.length) {
        st.thoughtShownLen = advanceStreamCursor(
          thoughtTarget,
          st.thoughtShownLen,
          !isTurnActive,
        );
        changed = true;
      }
      if (st.textShownLen < textTarget.length) {
        st.textShownLen = advanceStreamCursor(
          textTarget,
          st.textShownLen,
          !isTurnActive,
        );
        changed = true;
      }

      if (changed) {
        const el = scrollEl.querySelector(`.turn-block[data-turn-idx="${turn.turnIndex}"]`);
        if (el) {
          updateTurnElement(el, task, turn);
        }
      }
    }

    if (wasNearBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }, STREAM_TICK_MS);
}

function patchMarkdownBlocks(container, markdownText, showCursor) {
  const blocks = splitMarkdownBlocks(markdownText);
  const existing = Array.from(container.children);

  // Remove excess trailing blocks if text shrank/reset
  while (existing.length > blocks.length) {
    existing.pop().remove();
  }

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const isLast = idx === blocks.length - 1;
    const blockText = blocks[idx];
    const sig = `${blockText.length}:${blockText.slice(0, 40)}:${blockText.slice(-40)}:${
      isLast && showCursor ? 1 : 0
    }`;
    let blockEl = container.children[idx];
    if (!blockEl) {
      blockEl = document.createElement("div");
      blockEl.className = "md-block";
      container.appendChild(blockEl);
    }
    if (blockEl.dataset.blockSig !== sig) {
      blockEl.dataset.blockSig = sig;
      let html = renderMarkdown(blockText);
      if (isLast && showCursor) {
        html += `<span class="stream-cursor" aria-hidden="true"></span>`;
      }
      blockEl.innerHTML = html;
    }
  }
}

function callToolWithTimeout(name, args, timeoutMs = CALL_TIMEOUT_MS) {
  return Promise.race([
    app.callServerTool({ name, arguments: args }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`工具调用超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs),
    ),
  ]);
}

function enqueueAction(fn) {
  const next = state.actionChain.then(fn, fn);
  state.actionChain = next.catch(() => {});
  return next;
}

function mountShell() {
  if (state.shellMounted) return;
  state.shellMounted = true;

  rootEl.innerHTML = `
    <header id="topbar" class="pane-topbar"></header>
    <section id="task-header" class="task-header" style="display:none;"></section>
    <section id="sticky-bar-wrap" class="sticky-bar-wrap" style="display:none;">
      <div id="sticky-bar" class="sticky-bar"></div>
      <div id="sticky-drawer" class="sticky-drawer" style="display:none;"></div>
    </section>
    <section id="sticky-approvals" class="sticky-approvals" style="display:none;"></section>
    <main id="pane-scroll" class="pane-scroll"></main>
    <footer id="pane-footer" class="pane-footer" style="display:none;">
      <div id="handoff-bar" class="handoff-bar"></div>
      <div class="composer">
        <textarea
          id="composer-input"
          class="composer-textarea"
          placeholder="在此直接向当前 ACP 会话继续追问（Ctrl+Enter 发送）..."
        ></textarea>
        <div class="composer-row">
          <div style="display:flex;align-items:center;gap:6px;">
            <select id="policy-select" class="policy-select" title="本轮权限策略">
              <option value="interactive">策略: 面板审批</option>
              <option value="read_only">策略: 只读</option>
              <option value="accept_edits">策略: 允许编辑</option>
              <option value="allow_all">策略: 全放行</option>
            </select>
            <span id="composer-hint" style="font-size:11px;color:var(--text-tertiary);"></span>
          </div>
          <button id="send-btn" type="button" class="btn btn-primary">发送追问</button>
        </div>
      </div>
    </footer>
  `;

  dom.topbar = document.getElementById("topbar");
  dom.taskHeader = document.getElementById("task-header");
  dom.stickyBarWrap = document.getElementById("sticky-bar-wrap");
  dom.stickyBar = document.getElementById("sticky-bar");
  dom.stickyDrawer = document.getElementById("sticky-drawer");
  dom.stickyApprovals = document.getElementById("sticky-approvals");
  dom.scroll = document.getElementById("pane-scroll");
  dom.handoffBar = document.getElementById("handoff-bar");
  dom.composerInput = document.getElementById("composer-input");
  dom.policySelect = document.getElementById("policy-select");
  dom.sendBtn = document.getElementById("send-btn");
  dom.composerHint = document.getElementById("composer-hint");

  dom.composerInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      handleSendFollowUp();
    }
  });

  dom.sendBtn.addEventListener("click", () => {
    const task = state.activeTask;
    if (task && (task.status === "running" || task.status === "waiting_approval")) {
      handleCancelTask(task.taskId);
    } else {
      handleSendFollowUp();
    }
  });

  rootEl.addEventListener("click", handleDelegatedClick);
  const scrollFadeTimers = new WeakMap();
  rootEl.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      target.classList.add("is-scrolling");
      const prevTimer = scrollFadeTimers.get(target);
      if (prevTimer) clearTimeout(prevTimer);
      scrollFadeTimers.set(
        target,
        setTimeout(() => {
          target.classList.remove("is-scrolling");
        }, 700),
      );
    },
    true,
  );

  dom.scroll.addEventListener(
    "toggle",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLDetailsElement && target.dataset.detailKey) {
        state.expandedDetails.set(target.dataset.detailKey, target.open);
        if (target.open && target.classList.contains("thought-box")) {
          const contentEl = target.querySelector(".thought-content");
          if (contentEl) {
            contentEl.scrollTop = contentEl.scrollHeight;
          }
        }
      }
    },
    true,
  );

  dom.scroll.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains("thought-content")) {
        const key = target.dataset.thoughtKey;
        if (key) {
          const nearBottom =
            target.scrollHeight - target.scrollTop - target.clientHeight < 28;
          state.thoughtUserScrolled.set(key, !nearBottom);
        }
      } else if (target.classList.contains("assistant-body")) {
        const key = target.dataset.bodyKey;
        if (key) {
          const nearBottom =
            target.scrollHeight - target.scrollTop - target.clientHeight < 32;
          state.bodyUserScrolled.set(key, !nearBottom);
        }
      }
    },
    true,
  );
}

function getFilteredTasks() {
  const tasks = state.workspace?.tasks ?? [];
  if (state.filter === "active") {
    return tasks.filter(
      (t) => t.status === "running" || t.status === "waiting_approval" || t.pendingApprovalCount > 0,
    );
  }
  return tasks;
}

function renderTopbar() {
  const ws = state.workspace;
  const tasks = getFilteredTasks();
  const totalCount = ws?.totalTasks ?? 0;
  const runningCount = ws?.runningCount ?? 0;
  const waitingCount = ws?.waitingApprovalCount ?? 0;

  const alertHtml =
    waitingCount > 0
      ? `<button type="button" class="pill-alert" data-action="jump-approval">${waitingCount} 项待审批</button>`
      : "";

  const tabsHtml =
    tasks.length > 0
      ? `<div class="task-tabs">${tasks
          .map((t) => {
            const activeCls = t.taskId === state.activeTaskId ? "active" : "";
            const badge =
              t.pendingApprovalCount > 0
                ? `<span class="task-tab-badge">${t.pendingApprovalCount}</span>`
                : "";
            return `<button type="button" class="task-tab ${activeCls}" data-select-task="${escapeHtml(
              t.taskId,
            )}" title="${escapeHtml(t.title)}">
              <span class="dot dot-${escapeHtml(t.status)}"></span>
              <span class="task-tab-harness">${escapeHtml(t.harness)}</span>
              <span class="task-tab-title">${escapeHtml(t.title)}</span>
              ${badge}
            </button>`;
          })
          .join("")}</div>`
      : "";

  dom.topbar.innerHTML = `
    <div class="topbar-row">
      <div class="topbar-title">
        <span class="topbar-logo">ACP</span>
        <h1 class="topbar-heading">ACP 任务台</h1>
        ${
          totalCount > 0
            ? `<span class="chip">${runningCount > 0 ? `${runningCount} 运行中 · ` : ""}${totalCount} 任务</span>`
            : ""
        }
      </div>
      <div class="topbar-actions">
        ${alertHtml}
        <button type="button" class="btn btn-sm ${
          state.filter === "active" ? "btn-active" : ""
        }" data-action="toggle-filter">${state.filter === "active" ? "仅活跃" : "全部"}</button>
        <button type="button" class="btn btn-sm" data-action="refresh" ${
          state.pendingActions.has("refresh") ? "disabled" : ""
        }>刷新</button>
      </div>
    </div>
    ${tabsHtml}
  `;
}

function renderTaskHeader() {
  const task = state.activeTask;
  if (!task) {
    dom.taskHeader.style.display = "none";
    dom.taskHeader.innerHTML = "";
    return;
  }

  dom.taskHeader.style.display = "flex";
  const isActive = task.status === "running" || task.status === "waiting_approval";
  const statusChipCls =
    task.status === "completed"
      ? "chip-success"
      : task.status === "waiting_approval"
        ? "chip-warning"
        : task.status === "failed"
          ? "chip-danger"
          : task.status === "running"
            ? "chip-info"
            : "";

  const elapsed = formatDuration(task.startedAt, isActive ? null : task.finishedAt);

  dom.taskHeader.innerHTML = `
    <div class="task-header-top">
      <h2 class="task-header-title">${escapeHtml(task.title)}</h2>
      <div style="display:flex;gap:5px;flex-shrink:0;">
        ${
          isActive
            ? `<button type="button" class="btn btn-sm btn-danger" data-action="cancel-task" data-task-id="${escapeHtml(
                task.taskId,
              )}" ${state.pendingActions.has(`cancel:${task.taskId}`) ? "disabled" : ""}>停止</button>`
            : ""
        }
        ${
          !task.sessionClosed
            ? `<button type="button" class="btn btn-sm" data-action="close-session" data-task-id="${escapeHtml(
                task.taskId,
              )}" ${
                state.pendingActions.has(`close:${task.taskId}`) ? "disabled" : ""
              }>关闭会话</button>`
            : task.restoredFromDisk
              ? `<span class="chip">历史记录</span>`
              : `<span class="chip">会话已关闭</span>`
        }
      </div>
    </div>
    <div class="task-meta-chips">
      <span class="chip ${statusChipCls}">
        <span class="dot dot-${escapeHtml(task.status)}"></span>
        ${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}
      </span>
      <span class="chip">${escapeHtml(task.harnessDisplayName || task.harness)}</span>
      ${task.model ? `<span class="chip chip-mono" title="${escapeHtml(task.model)}">${escapeHtml(task.model)}</span>` : ""}
      <span class="chip">${escapeHtml(POLICY_LABELS[task.approvalPolicy] ?? task.approvalPolicy)}</span>
      ${
        elapsed
          ? `<span class="chip" data-live-elapsed="${task.startedAt}" data-finished="${
              isActive ? "" : task.finishedAt ?? ""
            }">用时 ${escapeHtml(elapsed)}</span>`
          : ""
      }
      <button type="button" class="chip chip-mono" data-copy-text="${escapeHtml(
        task.cwd,
      )}" title="点击复制工作目录: ${escapeHtml(task.cwd)}" style="cursor:pointer;">${escapeHtml(
        task.cwd,
      )}</button>
    </div>
  `;
}

function renderStickyDrawerBar() {
  const task = state.activeTask;
  if (!task) {
    dom.stickyBarWrap.style.display = "none";
    return;
  }

  const plan = getLatestPlan(task);
  const files = task.files ?? [];
  const planDone = plan ? plan.filter((p) => p.status === "completed").length : 0;
  const planCountLabel = plan ? `${planDone}/${plan.length}` : "0";
  const filesCountLabel = String(files.length);

  dom.stickyBarWrap.style.display = "flex";
  dom.stickyBar.innerHTML = `
    <button type="button" class="drawer-toggle ${
      state.openDrawer === "plan" ? "open" : ""
    }" data-toggle-drawer="plan">
      <span>任务计划</span>
      <span class="drawer-count">${escapeHtml(planCountLabel)}</span>
      <span>${state.openDrawer === "plan" ? "▴" : "▾"}</span>
    </button>
    <button type="button" class="drawer-toggle ${
      state.openDrawer === "files" ? "open" : ""
    }" data-toggle-drawer="files">
      <span>涉及文件</span>
      <span class="drawer-count">${escapeHtml(filesCountLabel)}</span>
      <span>${state.openDrawer === "files" ? "▴" : "▾"}</span>
    </button>
  `;

  if (state.openDrawer === "plan") {
    dom.stickyDrawer.style.display = "block";
    if (!plan || plan.length === 0) {
      dom.stickyDrawer.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">当前任务尚未上报结构化计划步骤。</div>`;
    } else {
      dom.stickyDrawer.innerHTML = `<ul class="plan-list">${plan
        .map((p) => {
          const icon =
            p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○";
          return `<li class="plan-item ${escapeHtml(p.status)}"><span class="plan-icon">${icon}</span><span>${escapeHtml(
            p.content,
          )}</span></li>`;
        })
        .join("")}</ul>`;
    }
  } else if (state.openDrawer === "files") {
    dom.stickyDrawer.style.display = "block";
    if (files.length === 0) {
      dom.stickyDrawer.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);">尚未记录到文件读写操作。</div>`;
    } else {
      dom.stickyDrawer.innerHTML = `<div class="files-list">${files
        .map((file) => {
          const primaryAction = file.actions.includes("delete")
            ? "delete"
            : file.actions.includes("edit")
              ? "edit"
              : file.actions.includes("read")
                ? "read"
                : "other";
          const actMeta = ACTION_LABELS[primaryAction] ?? ACTION_LABELS.other;
          return `<button type="button" class="file-chip" data-open-file="${escapeHtml(
            file.path,
          )}" title="点击在侧栏预览：${escapeHtml(file.path)}">
            <span class="file-act ${actMeta.cls}">${actMeta.label}</span>
            <span class="file-chip-path">${escapeHtml(file.displayPath)}</span>
          </button>`;
        })
        .join("")}</div>`;
    }
  } else {
    dom.stickyDrawer.style.display = "none";
    dom.stickyDrawer.innerHTML = "";
  }
}

function renderStickyApprovals() {
  const task = state.activeTask;
  const approvals = task?.pendingApprovals ?? [];
  const sig = approvals
    .map((a) => `${a.approvalId}:${state.pendingActions.has(`apr:${a.approvalId}`) ? 1 : 0}`)
    .join("|");

  if (approvals.length === 0) {
    dom.stickyApprovals.style.display = "none";
    if (state.lastApprovalsSig !== "") {
      dom.stickyApprovals.innerHTML = "";
      state.lastApprovalsSig = "";
    }
    return;
  }

  dom.stickyApprovals.style.display = "flex";
  if (sig === state.lastApprovalsSig) return;
  state.lastApprovalsSig = sig;

  dom.stickyApprovals.innerHTML = approvals
    .map((apr) => {
      const busy = state.pendingActions.has(`apr:${apr.approvalId}`);
      const remaining = Math.max(0, Math.ceil((apr.expiresAt - Date.now()) / 1000));
      const locChips = (apr.locations ?? [])
        .map(
          (loc) =>
            `<button type="button" class="file-chip" data-open-file="${escapeHtml(
              loc,
            )}" title="在侧栏预览文件">${escapeHtml(loc)}</button>`,
        )
        .join("");

      const allowLabel = apr.willPersistAllow ? "允许（持久）" : "允许本次";
      const editBtn = isEditKind(apr)
        ? `<button type="button" class="btn btn-sm btn-success" data-resolve-approval="${escapeHtml(
            apr.approvalId,
          )}" data-decision="allow_edits_turn" ${busy ? "disabled" : ""}>本轮放行编辑</button>`
        : "";

      return `
        <section class="approval-card">
          <div class="approval-header">
            <div class="approval-title">
              <span>请求执行权限：${escapeHtml(apr.toolName)}</span>
              ${apr.kind ? `<span class="chip chip-warning">${escapeHtml(apr.kind)}</span>` : ""}
            </div>
            <span class="approval-countdown" data-approval-countdown="${apr.expiresAt}">${remaining}s 后自动拒绝</span>
          </div>
          ${apr.title && apr.title !== apr.toolName ? `<div style="font-size:12px;">${escapeHtml(apr.title)}</div>` : ""}
          ${locChips ? `<div class="files-list">${locChips}</div>` : ""}
          ${renderPreviewBlock(apr.preview, apr.inputSummary)}
          <div class="approval-actions">
            <button type="button" class="btn btn-sm btn-primary" data-resolve-approval="${escapeHtml(
              apr.approvalId,
            )}" data-decision="allow_once" ${busy ? "disabled" : ""}>${allowLabel}</button>
            ${editBtn}
            <button type="button" class="btn btn-sm" data-resolve-approval="${escapeHtml(
              apr.approvalId,
            )}" data-decision="allow_all_turn" ${busy ? "disabled" : ""}>本轮全部放行</button>
            <button type="button" class="btn btn-sm btn-danger" data-resolve-approval="${escapeHtml(
              apr.approvalId,
            )}" data-decision="reject" ${busy ? "disabled" : ""}>拒绝</button>
          </div>
        </section>
      `;
    })
    .join("");
}

function createTurnElement(turn) {
  const el = document.createElement("article");
  el.className = "turn-block";
  el.dataset.turnIdx = String(turn.turnIndex);
  el.innerHTML = `
    <div class="prompt-bubble">
      <div class="prompt-meta"></div>
      <div class="prompt-text"></div>
    </div>
    <div class="turn-thought-slot"></div>
    <div class="turn-tools-slot"></div>
    <div class="turn-body-slot"></div>
    <div class="turn-notices-slot"></div>
  `;
  return el;
}

function updateTurnElement(el, task, turn) {
  const isTurnActive = turn.status === "running" || turn.status === "waiting_approval";
  const isUserSource = turn.source === "ui";
  const roleBadgeHtml = isUserSource
    ? `<span class="role-tag role-tag-user">用户追问</span>`
    : `<span class="role-tag role-tag-agent">主 Agent 委派</span>`;
  const replyToLabel = isUserSource ? "回复用户" : "回复主 Agent";
  const turnDuration = formatDuration(turn.startedAt, isTurnActive ? null : turn.finishedAt);

  // 1. Prompt bubble (distinct visual styling for Main Agent vs User, capped at 22vh with expand toggle)
  const promptBubble = el.querySelector(".prompt-bubble");
  const promptExpandKey = `prompt:${task.taskId}:${turn.turnIndex}`;
  const isPromptExpanded = state.expandedCards.has(promptExpandKey);
  promptBubble.classList.toggle("role-user", isUserSource);
  promptBubble.classList.toggle("is-expanded", isPromptExpanded);
  const metaSig = `${turn.turnIndex}|${turn.source}|${turn.approvalPolicy}|${turnDuration}|${
    isPromptExpanded ? 1 : 0
  }`;
  if (el.dataset.metaSig !== metaSig) {
    el.dataset.metaSig = metaSig;
    const togglePromptBtn =
      (turn.prompt ?? "").length > 180
        ? `<button type="button" class="btn btn-sm btn-ghost" data-toggle-expand="${escapeHtml(
            promptExpandKey,
          )}">${isPromptExpanded ? "收起" : "展开"}</button>`
        : "";
    el.querySelector(".prompt-meta").innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">${roleBadgeHtml}<span>第 ${turn.turnIndex} 轮 · ${escapeHtml(
      POLICY_LABELS[turn.approvalPolicy] ?? turn.approvalPolicy,
    )}</span></span><span style="display:inline-flex;align-items:center;gap:4px;"><span>${escapeHtml(
      turnDuration,
    )}</span>${togglePromptBtn}</span>`;
  }
  if (el.dataset.promptSet !== "1") {
    el.dataset.promptSet = "1";
    el.querySelector(".prompt-text").textContent = turn.prompt;
  }

  // 2. Thought box (persistent DOM node with smooth chunk streaming & auto-scroll bottom)
  const streamState = getOrInitTurnStream(task.taskId, turn);
  const thoughtSlot = el.querySelector(".turn-thought-slot");
  const fullThought = turn.thought ?? "";
  const shownThought = fullThought.slice(0, streamState.thoughtShownLen);
  const thoughtKey = `thought:${task.taskId}:${turn.turnIndex}`;
  if (fullThought.trim()) {
    let detailsEl = thoughtSlot.querySelector("details.thought-box");
    if (!detailsEl) {
      const defaultOpen = isTurnActive && !(turn.text && turn.text.trim());
      const isOpen = state.expandedDetails.has(thoughtKey)
        ? state.expandedDetails.get(thoughtKey)
        : defaultOpen;
      detailsEl = document.createElement("details");
      detailsEl.className = "thought-box";
      detailsEl.dataset.detailKey = thoughtKey;
      detailsEl.open = isOpen;
      detailsEl.innerHTML = `
        <summary class="thought-summary">
          <span>思考过程</span>
          <span class="thought-len"></span>
        </summary>
        <div class="thought-content" data-thought-key="${escapeHtml(thoughtKey)}"></div>
      `;
      thoughtSlot.appendChild(detailsEl);
    }

    const contentEl = detailsEl.querySelector(".thought-content");
    const lenEl = detailsEl.querySelector(".thought-len");
    const thoughtSig = `${shownThought.length}/${fullThought.length}`;
    if (el.dataset.thoughtSig !== thoughtSig) {
      el.dataset.thoughtSig = thoughtSig;
      lenEl.textContent = `${fullThought.length} 字`;
      const userScrolledUp = state.thoughtUserScrolled.get(thoughtKey) === true;
      const prevTop = contentEl.scrollTop;
      contentEl.textContent = shownThought;
      if (!userScrolledUp) {
        contentEl.scrollTop = contentEl.scrollHeight;
      } else {
        contentEl.scrollTop = prevTop;
      }
    }
  } else if (thoughtSlot.childElementCount > 0) {
    thoughtSlot.innerHTML = "";
    el.dataset.thoughtSig = "";
  }

  // 3. Collapsible Tool Calls Group (all tool calls collapse into 1 summary row by default)
  const toolsSlot = el.querySelector(".turn-tools-slot");
  const toolCalls = turn.toolCalls ?? [];
  if (toolCalls.length > 0) {
    const toolsSig = toolCalls
      .map((tc) => `${tc.toolCallId}:${tc.status}:${tc.updatedAt}`)
      .join("|");
    if (el.dataset.toolsSig !== toolsSig) {
      el.dataset.toolsSig = toolsSig;
      const groupKey = `toolgroup:${task.taskId}:${turn.turnIndex}`;
      const groupOpen = state.expandedDetails.get(groupKey) ?? false;
      const doneCount = toolCalls.filter((tc) => tc.status === "completed").length;
      const failCount = toolCalls.filter((tc) => tc.status === "failed").length;
      const runningTc = toolCalls.find(
        (tc) => tc.status === "in_progress" || tc.status === "pending",
      );
      const groupDot = runningTc
        ? "running"
        : failCount > 0
          ? "failed"
          : "completed";
      const hintText = runningTc
        ? `正在执行 ${runningTc.toolName}${runningTc.title && runningTc.title !== runningTc.toolName ? ` · ${runningTc.title}` : ""}`
        : `${doneCount}/${toolCalls.length} 已完成${failCount > 0 ? ` · ${failCount} 失败` : ""}`;

      const itemsHtml = toolCalls
        .map((tc) => {
          const tcKey = `tc:${task.taskId}:${turn.turnIndex}:${tc.toolCallId}`;
          const tcOpen = state.expandedDetails.get(tcKey) ?? false;
          const dotStatus =
            tc.status === "completed"
              ? "completed"
              : tc.status === "failed"
                ? "failed"
                : tc.status === "in_progress"
                  ? "running"
                  : "cancelled";
          const locHtml = (tc.locations ?? [])
            .map(
              (loc) =>
                `<button type="button" class="file-chip" data-open-file="${escapeHtml(
                  loc,
                )}" title="在侧栏预览">${escapeHtml(loc)}</button>`,
            )
            .join("");
          return `
            <details class="tool-item" data-detail-key="${escapeHtml(tcKey)}" ${
              tcOpen ? "open" : ""
            }>
              <summary class="tool-summary">
                <span class="tool-summary-left">
                  <span class="dot dot-${dotStatus}"></span>
                  <span class="tool-name">${escapeHtml(tc.toolName)}</span>
                  <span class="tool-title">${escapeHtml(tc.title || tc.kind || "")}</span>
                </span>
                <span class="tool-status">${escapeHtml(tc.status)}</span>
              </summary>
              <div class="tool-body">
                ${locHtml ? `<div class="files-list">${locHtml}</div>` : ""}
                ${renderPreviewBlock(tc.preview, tc.inputSummary)}
              </div>
            </details>
          `;
        })
        .join("");

      toolsSlot.innerHTML = `
        <details class="tool-group" data-detail-key="${escapeHtml(groupKey)}" ${
          groupOpen ? "open" : ""
        }>
          <summary class="tool-group-summary">
            <span class="tool-group-left">
              <span class="dot dot-${groupDot}"></span>
              <strong>工具调用 (${toolCalls.length})</strong>
              <span class="tool-group-hint">${escapeHtml(hintText)}</span>
            </span>
            <span>▾</span>
          </summary>
          <div class="tool-group-body">${itemsHtml}</div>
        </details>
      `;
    }
  } else if (toolsSlot.childElementCount > 0) {
    toolsSlot.innerHTML = "";
    el.dataset.toolsSig = "";
  }

  // 4. Assistant response body with speaker header + block-level smooth LLM chunk streaming
  const bodySlot = el.querySelector(".turn-body-slot");
  const fullText = turn.text ?? "";
  const shownText = fullText.slice(0, streamState.textShownLen);
  const isCatchingUp = streamState.textShownLen < fullText.length;
  const showStreamCursor = isTurnActive || isCatchingUp;
  const assistantName = task.harnessDisplayName || task.harness || "ACP 助手";
  const cardStateCls = showStreamCursor
    ? "is-streaming"
    : turn.status === "failed"
      ? "is-error"
      : "";

  if (shownText.trim() || fullText.trim()) {
    const bodyExpandKey = `body:${task.taskId}:${turn.turnIndex}`;
    const isBodyExpanded = state.expandedCards.has(bodyExpandKey);
    let cardEl = bodySlot.querySelector(".assistant-card");
    if (!cardEl) {
      bodySlot.innerHTML = `<div class="assistant-card ${cardStateCls}">
        <div class="assistant-header">
          <div class="assistant-header-left">
            <span class="role-tag role-tag-assistant"></span>
            <span class="assistant-reply-to"></span>
          </div>
          <span class="assistant-header-right"></span>
        </div>
        <div class="assistant-body" data-body-key="${escapeHtml(bodyExpandKey)}">
          <div class="markdown-body"></div>
        </div>
      </div>`;
      cardEl = bodySlot.querySelector(".assistant-card");
    }

    cardEl.className = `assistant-card ${cardStateCls} ${isBodyExpanded ? "is-expanded" : ""}`.trim();
    const showExpandBtn = fullText.length > 360;
    const headerSig = `${assistantName}|${replyToLabel}|${showStreamCursor ? 1 : 0}|${
      turn.turnIndex
    }|${isBodyExpanded ? 1 : 0}|${showExpandBtn ? 1 : 0}`;
    if (cardEl.dataset.headerSig !== headerSig) {
      cardEl.dataset.headerSig = headerSig;
      cardEl.querySelector(".role-tag-assistant").textContent = assistantName;
      cardEl.querySelector(".assistant-reply-to").textContent = replyToLabel;
      const expandBtnHtml = showExpandBtn
        ? `<button type="button" class="btn btn-sm btn-ghost" data-toggle-expand="${escapeHtml(
            bodyExpandKey,
          )}">${isBodyExpanded ? "收起" : "展开"}</button>`
        : "";
      const rightActionHtml = !showStreamCursor
        ? `<button type="button" class="btn btn-sm btn-ghost" data-copy-turn="${turn.turnIndex}" title="复制本轮回答">复制</button>`
        : `<span class="chip chip-info" style="font-size:10px;">输出中</span>`;
      cardEl.querySelector(".assistant-header-right").innerHTML = `${expandBtnHtml}${rightActionHtml}`;
    }

    const bodyEl = cardEl.querySelector(".assistant-body");
    const mdContainer = cardEl.querySelector(".markdown-body");
    const mdSig = `${shownText.length}|${showStreamCursor ? 1 : 0}`;
    if (cardEl.dataset.mdSig !== mdSig) {
      cardEl.dataset.mdSig = mdSig;
      const userScrolledUp = state.bodyUserScrolled.get(bodyExpandKey) === true;
      const prevBodyTop = bodyEl.scrollTop;
      patchMarkdownBlocks(mdContainer, shownText, showStreamCursor);
      if (showStreamCursor && !isBodyExpanded && !userScrolledUp) {
        bodyEl.scrollTop = bodyEl.scrollHeight;
      } else if (!isBodyExpanded) {
        bodyEl.scrollTop = prevBodyTop;
      }
    }
  } else if (isTurnActive) {
    const waitSig = `wait:${turn.status}:${assistantName}`;
    if (bodySlot.dataset.waitSig !== waitSig) {
      bodySlot.dataset.waitSig = waitSig;
      bodySlot.innerHTML = `<div class="notice-box notice-info">${
        turn.status === "waiting_approval"
          ? `${escapeHtml(assistantName)} 已暂停，等待你在上方审批卡片中确认权限…`
          : `${escapeHtml(assistantName)} 正在执行并实时回传进展…`
      }</div>`;
    }
  } else if (bodySlot.childElementCount > 0) {
    bodySlot.innerHTML = "";
    bodySlot.dataset.waitSig = "";
  }

  // 5. Notices (warnings, elicitations, deniedPermissions, error)
  const noticesSlot = el.querySelector(".turn-notices-slot");
  const noticeSig = JSON.stringify({
    w: turn.warnings?.length ?? 0,
    e: turn.elicitations?.length ?? 0,
    d: turn.deniedPermissions?.length ?? 0,
    err: turn.error ?? "",
  });
  if (el.dataset.noticeSig !== noticeSig) {
    el.dataset.noticeSig = noticeSig;
    const parts = [];
    if (turn.elicitations?.length > 0) {
      parts.push(
        `<div class="notice-box notice-info"><strong>外部 Agent 提问：</strong>${turn.elicitations
          .map((q) => `<div>• ${escapeHtml(q.message)}</div>`)
          .join("")}</div>`,
      );
    }
    if (turn.deniedPermissions?.length > 0) {
      parts.push(
        `<div class="notice-box notice-warn"><strong>已拦截 ${turn.deniedPermissions.length} 项权限请求：</strong>${turn.deniedPermissions
          .map(
            (d) =>
              `<div>• <code>${escapeHtml(d.toolName)}</code> (${escapeHtml(
                d.kind || "unknown",
              )}) ${escapeHtml(d.reason ?? d.policy ?? "")}</div>`,
          )
          .join("")}</div>`,
      );
    }
    if (turn.warnings?.length > 0) {
      parts.push(
        `<div class="notice-box notice-warn"><strong>提示：</strong>${escapeHtml(
          turn.warnings.join("；"),
        )}</div>`,
      );
    }
    if (turn.error) {
      parts.push(
        `<div class="notice-box notice-err"><strong>执行出错：</strong>${escapeHtml(
          turn.error,
        )}</div>`,
      );
    }
    noticesSlot.innerHTML = parts.join("");
  }
}

function renderTurnsIncremental() {
  const scrollEl = dom.scroll;
  const task = state.activeTask;

  if (!task) {
    state.renderedTaskId = null;
    scrollEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">ACP</div>
        <div style="font-size:14px;font-weight:650;color:var(--text-primary);">暂无 ACP 任务记录</div>
        <div style="font-size:12px;line-height:1.6;">
          在主对话中对 Antigravity 说「把这个任务派给 Claude Code」，右侧任务台会自动弹出并实时展示执行计划、工具调用、涉及文件预览与权限审批。
        </div>
      </div>
    `;
    return;
  }

  const switchedTask = state.renderedTaskId !== task.taskId;
  const wasNearBottom =
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 56;

  if (switchedTask) {
    state.renderedTaskId = task.taskId;
    scrollEl.innerHTML = "";
  }

  const turns = task.turns ?? [];
  if (turns.length === 0) {
    scrollEl.innerHTML = `<div class="notice-box notice-info">任务已初始化，正在等待首个回合启动…</div>`;
    return;
  }

  // Remove non-turn placeholder if present
  if (scrollEl.firstElementChild && !scrollEl.firstElementChild.classList.contains("turn-block")) {
    scrollEl.innerHTML = "";
  }

  const existingByIdx = new Map();
  for (const child of Array.from(scrollEl.children)) {
    if (child.classList.contains("turn-block") && child.dataset.turnIdx) {
      existingByIdx.set(Number(child.dataset.turnIdx), child);
    }
  }

  const validIndices = new Set(turns.map((t) => t.turnIndex));
  for (const [idx, node] of existingByIdx.entries()) {
    if (!validIndices.has(idx)) {
      node.remove();
      existingByIdx.delete(idx);
    }
  }

  for (const turn of turns) {
    let el = existingByIdx.get(turn.turnIndex);
    if (!el) {
      el = createTurnElement(turn);
      scrollEl.appendChild(el);
    }
    updateTurnElement(el, task, turn);
  }

  if (switchedTask || wasNearBottom) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  ensureStreamLoop();
}

function renderFooter() {
  const footerEl = document.getElementById("pane-footer");
  const task = state.activeTask;
  if (!task) {
    footerEl.style.display = "none";
    return;
  }

  footerEl.style.display = "flex";
  const canMsg = Boolean(state.hostCaps?.message);
  const canCtx = Boolean(state.hostCaps?.updateModelContext);
  const ctxAttached = state.contextAttachedTaskId === task.taskId;

  const buttons = [];
  if (canMsg) {
    buttons.push(
      `<button type="button" class="btn btn-sm btn-primary" data-action="handoff-message" ${
        state.pendingActions.has("handoff") ? "disabled" : ""
      }>回报给主对话</button>`,
    );
  }
  if (canCtx) {
    buttons.push(
      `<button type="button" class="btn btn-sm ${
        ctxAttached ? "btn-active" : ""
      }" data-action="toggle-context" ${
        state.pendingActions.has("context") ? "disabled" : ""
      }>${ctxAttached ? "已附到下条上下文（点击取消）" : "附为下条上下文"}</button>`,
    );
  }
  buttons.push(
    `<button type="button" class="btn btn-sm" data-action="copy-result">复制结论</button>`,
  );
  dom.handoffBar.innerHTML = buttons.join("");

  const isRunning = task.status === "running" || task.status === "waiting_approval";
  const isSending = state.pendingActions.has("followup");
  const canResumeFromHistory = Boolean(task.sessionClosed && task.restoredFromDisk);

  if (task.sessionClosed && !canResumeFromHistory) {
    dom.composerInput.disabled = true;
    dom.policySelect.disabled = true;
    dom.sendBtn.disabled = true;
    dom.sendBtn.className = "btn";
    dom.sendBtn.textContent = "会话已关闭";
    dom.composerHint.textContent = "请从主对话派发新任务";
  } else if (isRunning) {
    dom.composerInput.disabled = true;
    dom.policySelect.disabled = true;
    dom.sendBtn.disabled = state.pendingActions.has(`cancel:${task.taskId}`);
    dom.sendBtn.className = "btn btn-danger";
    dom.sendBtn.textContent = "中断本轮";
    dom.composerHint.textContent =
      task.status === "waiting_approval" ? "等待上方权限审批" : "外部 Agent 执行中…";
  } else {
    dom.composerInput.disabled = isSending;
    dom.policySelect.disabled = isSending;
    dom.sendBtn.disabled = isSending;
    dom.sendBtn.className = "btn btn-primary";
    dom.sendBtn.textContent = isSending
      ? "发送中…"
      : canResumeFromHistory
        ? "恢复并追问"
        : "发送追问";
    dom.composerHint.textContent = canResumeFromHistory
      ? "历史任务 · 发送时自动尝试恢复原会话"
      : "Ctrl+Enter 发送";
  }
}

function renderAll({ skipTurns = false } = {}) {
  mountShell();
  renderTopbar();
  renderTaskHeader();
  renderStickyDrawerBar();
  renderStickyApprovals();
  if (!skipTurns) {
    renderTurnsIncremental();
  }
  renderFooter();
}

function applyWorkspacePayload(payload, { focusFromPayload = false } = {}) {
  if (!payload || typeof payload !== "object") return;

  // M4 fix: ignore stale out-of-order poll responses for the same active task.
  if (
    !focusFromPayload &&
    payload.activeTask &&
    state.activeTaskId &&
    payload.activeTask.taskId === state.activeTaskId &&
    (payload.activeTask.seq ?? 0) < state.lastSeq
  ) {
    return;
  }

  state.workspace = {
    serverTime: payload.serverTime ?? Date.now(),
    totalTasks: payload.totalTasks ?? (payload.tasks?.length ?? 0),
    runningCount: payload.runningCount ?? 0,
    waitingApprovalCount: payload.waitingApprovalCount ?? 0,
    tasks: payload.tasks ?? [],
  };

  if (focusFromPayload && payload.activeTaskId) {
    if (state.activeTaskId !== payload.activeTaskId) {
      state.lastSeq = 0;
    }
    state.activeTaskId = payload.activeTaskId;
  } else if (!state.activeTaskId && payload.activeTaskId) {
    state.activeTaskId = payload.activeTaskId;
  } else if (
    state.activeTaskId &&
    !state.workspace.tasks.some((t) => t.taskId === state.activeTaskId)
  ) {
    state.activeTaskId = payload.activeTaskId ?? state.workspace.tasks[0]?.taskId ?? null;
    state.lastSeq = 0;
  }

  let skipTurns = false;
  if (payload.unchanged && state.activeTask && payload.activeTaskId === state.activeTaskId) {
    skipTurns = true;
  } else if (payload.activeTask) {
    state.activeTask = payload.activeTask;
    state.activeTaskId = payload.activeTask.taskId;
    state.lastSeq = payload.activeTask.seq ?? 0;
  } else if (!state.activeTaskId) {
    state.activeTask = null;
    state.lastSeq = 0;
  }

  renderAll({ skipTurns });
  ensureStreamLoop();
}

function extractErrorMessage(res, fallback) {
  const txt = res?.content?.find((c) => c.type === "text")?.text;
  return txt || fallback;
}

async function fetchFullWorkspace(taskId = state.activeTaskId, { focus = false } = {}) {
  try {
    const res = await callToolWithTimeout(
      "acp_ui_get_workspace",
      taskId ? { task_id: taskId } : {},
    );
    if (res?.isError) {
      showToast(extractErrorMessage(res, "加载任务台失败"));
      return;
    }
    if (res?.structuredContent) {
      applyWorkspacePayload(res.structuredContent, { focusFromPayload: focus });
    }
  } catch (err) {
    showToast(`刷新失败：${err.message}`);
  }
}

async function pollOnce() {
  if (state.pollInFlight || document.hidden) return;
  state.pollInFlight = true;
  try {
    const res = await callToolWithTimeout("acp_ui_poll_task", {
      ...(state.activeTaskId ? { task_id: state.activeTaskId } : {}),
      since_seq: state.lastSeq,
    });
    if (!res?.isError && res?.structuredContent) {
      applyWorkspacePayload(res.structuredContent, { focusFromPayload: false });
    }
  } catch {
    // Transient timeout/error: next tick will recover automatically.
  } finally {
    state.pollInFlight = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (document.hidden) return;
  const hasRunning = (state.workspace?.runningCount ?? 0) > 0;
  const hasWaiting = (state.workspace?.waitingApprovalCount ?? 0) > 0;
  const hasTasks = (state.workspace?.totalTasks ?? 0) > 0;
  // Fast 350ms feed while actively streaming so smooth chunk rendering stays continuous.
  const intervalMs = hasRunning ? 350 : hasWaiting ? 900 : hasTasks ? 4500 : 10000;
  state.pollTimer = setTimeout(() => {
    void pollOnce();
  }, intervalMs);
}

async function handleOpenFile(filePath) {
  if (!filePath) return;
  const uri = toFileUri(filePath, state.activeTask?.cwd ?? "");
  try {
    const result = await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      },
      ToggleAuxPaneResultSchema,
    );
    if (result?.isError) {
      await copyToClipboard(filePath);
      showToast("无法打开该文件预览，已复制路径到剪贴板");
    } else {
      showToast("已在右侧栏打开文件预览");
    }
  } catch {
    await copyToClipboard(filePath);
    showToast("当前视图不支持直接预览，已复制文件路径");
  }
}

function handleResolveApproval(approvalId, decision) {
  const key = `apr:${approvalId}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  state.lastApprovalsSig = "";
  renderStickyApprovals();

  void enqueueAction(async () => {
    try {
      const res = await callToolWithTimeout("acp_ui_resolve_approval", {
        approval_id: approvalId,
        decision,
      });
      if (res?.isError) {
        showToast(extractErrorMessage(res, "审批操作失败"));
      } else {
        showToast(decision === "reject" ? "已拒绝权限请求" : "已放行权限请求");
        if (res?.structuredContent) {
          applyWorkspacePayload(res.structuredContent, { focusFromPayload: true });
        }
      }
    } catch (err) {
      showToast(`审批失败：${err.message}`);
    } finally {
      state.pendingActions.delete(key);
      state.lastApprovalsSig = "";
      renderStickyApprovals();
      scheduleNextPoll();
    }
  });
}

function handleSendFollowUp() {
  const task = state.activeTask;
  if (!task || (task.sessionClosed && !task.restoredFromDisk)) return;
  const text = dom.composerInput.value.trim();
  if (!text) return;
  if (state.pendingActions.has("followup")) return;

  state.pendingActions.add("followup");
  renderFooter();

  void enqueueAction(async () => {
    try {
      const res = await callToolWithTimeout("acp_ui_follow_up_task", {
        task_id: task.taskId,
        message: text,
        approval_policy: dom.policySelect.value,
      });
      if (res?.isError) {
        showToast(extractErrorMessage(res, "发送追问失败"));
      } else {
        dom.composerInput.value = "";
        if (res?.structuredContent) {
          applyWorkspacePayload(res.structuredContent, { focusFromPayload: true });
        }
        showToast(task.restoredFromDisk ? "已恢复会话并发送追问" : "追问已发送");
      }
    } catch (err) {
      showToast(`发送失败：${err.message}`);
    } finally {
      state.pendingActions.delete("followup");
      renderFooter();
      scheduleNextPoll();
    }
  });
}

function handleCancelTask(taskId) {
  const key = `cancel:${taskId}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  renderTaskHeader();
  renderFooter();

  void enqueueAction(async () => {
    try {
      const res = await callToolWithTimeout("acp_ui_cancel_task", { task_id: taskId });
      if (res?.isError) {
        showToast(extractErrorMessage(res, "中断失败"));
      } else {
        showToast("已发送中断信号");
        if (res?.structuredContent) {
          applyWorkspacePayload(res.structuredContent, { focusFromPayload: true });
        }
      }
    } catch (err) {
      showToast(`中断失败：${err.message}`);
    } finally {
      state.pendingActions.delete(key);
      renderTaskHeader();
      renderFooter();
    }
  });
}

function handleCloseSession(taskId) {
  const key = `close:${taskId}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  renderTaskHeader();

  void enqueueAction(async () => {
    try {
      const res = await callToolWithTimeout("acp_ui_close_task_session", { task_id: taskId });
      if (res?.isError) {
        showToast(extractErrorMessage(res, "关闭会话失败"));
      } else {
        showToast("ACP 会话已关闭");
        if (res?.structuredContent) {
          applyWorkspacePayload(res.structuredContent, { focusFromPayload: true });
        }
      }
    } catch (err) {
      showToast(`关闭会话失败：${err.message}`);
    } finally {
      state.pendingActions.delete(key);
      renderTaskHeader();
      renderFooter();
    }
  });
}

async function handleHandoffMessage() {
  const task = state.activeTask;
  if (!task || state.pendingActions.has("handoff")) return;
  state.pendingActions.add("handoff");
  renderFooter();
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: buildHandoffText(task) }],
    });
    showToast("已将任务结论回报给主对话");
  } catch (err) {
    showToast(`回报失败：${err.message}`);
  } finally {
    state.pendingActions.delete("handoff");
    renderFooter();
  }
}

async function handleToggleContext() {
  const task = state.activeTask;
  if (!task || state.pendingActions.has("context")) return;
  state.pendingActions.add("context");
  renderFooter();
  try {
    if (state.contextAttachedTaskId === task.taskId) {
      await app.updateModelContext({ content: [] });
      state.contextAttachedTaskId = null;
      showToast("已取消附加任务上下文");
    } else {
      await app.updateModelContext({
        content: [{ type: "text", text: buildHandoffText(task) }],
      });
      state.contextAttachedTaskId = task.taskId;
      showToast("已附加为下条消息上下文");
    }
  } catch (err) {
    showToast(`更新上下文失败：${err.message}`);
  } finally {
    state.pendingActions.delete("context");
    renderFooter();
  }
}

async function handleDelegatedClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const expandBtn = target.closest("[data-toggle-expand]");
  if (expandBtn) {
    const key = expandBtn.getAttribute("data-toggle-expand");
    if (key) {
      if (state.expandedCards.has(key)) {
        state.expandedCards.delete(key);
      } else {
        state.expandedCards.add(key);
      }
      renderTurnsIncremental();
    }
    return;
  }

  const drawerBtn = target.closest("[data-toggle-drawer]");
  if (drawerBtn) {
    const kind = drawerBtn.getAttribute("data-toggle-drawer");
    state.openDrawer = state.openDrawer === kind ? null : kind;
    renderStickyDrawerBar();
    return;
  }

  const link = target.closest("a[data-ext-url]");
  if (link) {
    event.preventDefault();
    const url = link.getAttribute("data-ext-url");
    if (url && state.hostCaps?.openLinks) {
      await app.openLink({ url }).catch(() => {});
    } else if (url) {
      await copyToClipboard(url);
      showToast("已复制链接地址");
    }
    return;
  }

  const copyCodeBtn = target.closest("[data-copy-code]");
  if (copyCodeBtn) {
    const key = copyCodeBtn.getAttribute("data-copy-code");
    const code = state.codeBlocksByKey.get(key) ?? "";
    const ok = await copyToClipboard(code);
    showToast(ok ? "已复制代码块" : "复制失败");
    return;
  }

  const copyTurnBtn = target.closest("[data-copy-turn]");
  if (copyTurnBtn) {
    const idx = Number(copyTurnBtn.getAttribute("data-copy-turn"));
    const turn = state.activeTask?.turns?.find((t) => t.turnIndex === idx);
    if (turn?.text) {
      const ok = await copyToClipboard(turn.text);
      showToast(ok ? `已复制第 ${idx} 轮回答` : "复制失败");
    }
    return;
  }

  const copyTextEl = target.closest("[data-copy-text]");
  if (copyTextEl) {
    const text = copyTextEl.getAttribute("data-copy-text") ?? "";
    const ok = await copyToClipboard(text);
    showToast(ok ? "已复制到剪贴板" : "复制失败");
    return;
  }

  const fileBtn = target.closest("[data-open-file]");
  if (fileBtn) {
    const filePath = fileBtn.getAttribute("data-open-file");
    await handleOpenFile(filePath);
    return;
  }

  const tabBtn = target.closest("[data-select-task]");
  if (tabBtn) {
    const taskId = tabBtn.getAttribute("data-select-task");
    if (taskId && taskId !== state.activeTaskId) {
      state.activeTaskId = taskId;
      state.lastSeq = 0;
      state.lastApprovalsSig = "";
      void enqueueAction(() => fetchFullWorkspace(taskId, { focus: true }));
    }
    return;
  }

  const resolveBtn = target.closest("[data-resolve-approval]");
  if (resolveBtn) {
    const approvalId = resolveBtn.getAttribute("data-resolve-approval");
    const decision = resolveBtn.getAttribute("data-decision");
    if (approvalId && decision) {
      handleResolveApproval(approvalId, decision);
    }
    return;
  }

  const actionBtn = target.closest("[data-action]");
  if (!actionBtn) return;
  const action = actionBtn.getAttribute("data-action");

  if (action === "refresh") {
    state.pendingActions.add("refresh");
    renderTopbar();
    void enqueueAction(async () => {
      await fetchFullWorkspace(state.activeTaskId, { focus: true });
      state.pendingActions.delete("refresh");
      renderTopbar();
    });
  } else if (action === "toggle-filter") {
    state.filter = state.filter === "all" ? "active" : "all";
    renderTopbar();
  } else if (action === "jump-approval") {
    const pendingTask = (state.workspace?.tasks ?? []).find(
      (t) => t.pendingApprovalCount > 0,
    );
    if (pendingTask) {
      state.activeTaskId = pendingTask.taskId;
      state.lastSeq = 0;
      state.lastApprovalsSig = "";
      void enqueueAction(() => fetchFullWorkspace(pendingTask.taskId, { focus: true }));
    }
  } else if (action === "cancel-task") {
    const tid = actionBtn.getAttribute("data-task-id");
    if (tid) handleCancelTask(tid);
  } else if (action === "close-session") {
    const tid = actionBtn.getAttribute("data-task-id");
    if (tid) handleCloseSession(tid);
  } else if (action === "handoff-message") {
    await handleHandoffMessage();
  } else if (action === "toggle-context") {
    await handleToggleContext();
  } else if (action === "copy-result") {
    const task = state.activeTask;
    const lastTurn = task?.turns?.[task.turns.length - 1];
    const ok = await copyToClipboard(lastTurn?.text || buildHandoffText(task));
    showToast(ok ? "已复制任务结论" : "复制失败");
  }
}

// Lightweight local 1s timer for live elapsed clock & approval countdown without re-rendering DOM.
setInterval(() => {
  const elapsedEl = document.querySelector("[data-live-elapsed]");
  if (elapsedEl) {
    const startedAt = Number(elapsedEl.getAttribute("data-live-elapsed"));
    const finishedAttr = elapsedEl.getAttribute("data-finished");
    if (startedAt && !finishedAttr) {
      elapsedEl.textContent = `用时 ${formatDuration(startedAt)}`;
    }
  }
  for (const el of document.querySelectorAll("[data-approval-countdown]")) {
    const expiresAt = Number(el.getAttribute("data-approval-countdown"));
    if (expiresAt) {
      const rem = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      el.textContent = `${rem}s 后自动拒绝`;
    }
  }
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  } else {
    void pollOnce();
  }
});

// --- MCP Apps SDK Bootstrap ---
const app = new App({ name: "ACP Task Pane", version: "2.1.0" }, {});

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.ontoolinput = () => {
  mountShell();
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applyWorkspacePayload(result.structuredContent, { focusFromPayload: true });
    scheduleNextPoll();
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

async function init() {
  mountShell();
  dom.scroll.innerHTML = `<div class="empty-state"><div class="empty-icon">ACP</div><div style="font-size:13px;font-weight:600;color:var(--text-primary);">正在连接 ACP Hub…</div></div>`;
  try {
    await app.connect();
    applyHostContext(app.getHostContext());
    state.hostCaps = app.getHostCapabilities() ?? {};
    renderFooter();
    // Brief 30ms window for host-pushed ontoolresult to arrive and avoid duplicate RPC.
    setTimeout(() => {
      if (!state.workspace) {
        void fetchFullWorkspace(null, { focus: true }).finally(() => scheduleNextPoll());
      } else {
        scheduleNextPoll();
      }
    }, 30);
  } catch (err) {
    dom.scroll.innerHTML = `<div class="notice-box notice-err">无法连接到 Antigravity 宿主：${escapeHtml(
      err.message,
    )}</div>`;
  }
}

void init();
