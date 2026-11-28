import { createGitExplorer } from "./git.js";
const $ = (selector) => document.querySelector(selector);
const state = {
  speedMode: localStorage.getItem("workflow.speedMode") || "default",
  tasks: [], filter: "all", selected: null, conversation: [],
  conversationError: "", draft: "", approvalDraft: "", riskDrafts: {},
  codexModels: [], codexDefaultModel: "", codexModelsLoading: false, selectedModel: localStorage.getItem("workflow.codexModel") || "",
  conversationStream: null, activeStreamMessage: null, pendingUserInput: null, answeringUserInput: false, sendingMessage: false, attachments: [], attachmentMenuOpen: false,
};
const gitExplorer = createGitExplorer({ api, confirm: confirmNearButton });
const sidebarResizeHandle = $("#sidebarResizeHandle");
function setWorkspaceSidebarWidth(width) {
  const max = Math.max(280, Math.min(460, window.innerWidth - 420));
  const value = Math.round(Math.max(220, Math.min(max, width)));
  document.body.style.setProperty("--workspace-sidebar-width", `${value}px`);
  sidebarResizeHandle.setAttribute("aria-valuenow", String(value));
  return value;
}
sidebarResizeHandle.addEventListener("pointerdown", (event) => {
  if (window.matchMedia("(max-width: 800px)").matches || event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = parseFloat(getComputedStyle($(".sidebar")).width);
  sidebarResizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add("sidebar-resizing");
  const move = (pointerEvent) => setWorkspaceSidebarWidth(startWidth + pointerEvent.clientX - startX);
  const finish = () => {
    document.body.classList.remove("sidebar-resizing");
    localStorage.setItem("workflow.sidebarWidth", String(parseFloat(getComputedStyle($(".sidebar")).width)));
    sidebarResizeHandle.removeEventListener("pointermove", move);
    sidebarResizeHandle.removeEventListener("pointerup", finish);
    sidebarResizeHandle.removeEventListener("pointercancel", finish);
  };
  sidebarResizeHandle.addEventListener("pointermove", move);
  sidebarResizeHandle.addEventListener("pointerup", finish);
  sidebarResizeHandle.addEventListener("pointercancel", finish);
});
sidebarResizeHandle.addEventListener("keydown", (event) => {
  if (window.matchMedia("(max-width: 800px)").matches || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const current = parseFloat(getComputedStyle($(".sidebar")).width);
  const value = setWorkspaceSidebarWidth(current + (event.key === "ArrowRight" ? 16 : -16));
  localStorage.setItem("workflow.sidebarWidth", String(value));
});
const phases = ["plan", "development", "dev_review", "code_review", "risk_review", "release", "done"];
const displayPhase = (phase) => phase === "plan_review" ? "plan" : phase;
const phaseLabels = {
  plan: "Plan 讨论", development: "开发阶段",
  dev_review: "开发结果审核", code_review: "自动 Code Review", risk_review: "风险审核",
  release: "自动发布", done: "完成",
};

const scrollbarHideTimers = new WeakMap();
document.addEventListener("wheel", (event) => {
  if (event.ctrlKey || !event.cancelable || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const title = event.target instanceof Element && event.target.closest(".conversation-panel > .panel-title");
  if (!title) return;
  const list = title.nextElementSibling;
  event.preventDefault();
  list.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientHeight : 1);
}, { passive: false });

document.addEventListener("scroll", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLElement) || !element.closest("#workspace")) return;
  element.classList.add("scrollbar-active");
  clearTimeout(scrollbarHideTimers.get(element));
  scrollbarHideTimers.set(element, window.setTimeout(() => {
    element.classList.remove("scrollbar-active");
    scrollbarHideTimers.delete(element);
  }, 1200));
}, { capture: true, passive: true });

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.detail || body?.msg || body?.error?.message || `请求失败 (${response.status})`);
  return body && Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function conversationText(message) {
  let text = String(message.text || "")
    .split("\n")
    .filter((line) => !/^\s*WORKFLOW_EVENT:\s*\{/.test(line))
    .join("\n")
    .trim();

  if (message.role === "user") {
    const contextMarker = "User request or context:\n";
    const contextIndex = text.lastIndexOf(contextMarker);
    if (contextIndex >= 0) text = text.slice(contextIndex + contextMarker.length).trim();

    if (["请完成 Plan 讨论并给出方案。", "请继续当前 Plan 分析。", "你刚才只返回了工作流标记，没有输出用户可见的方案正文。"].some((prefix) => text.startsWith(prefix))) return "";

    const reviewRequest = "请根据以下审核意见调整方案：";
    if (text.startsWith(reviewRequest)) text = text.slice(reviewRequest.length).trim();
    if (text.startsWith("已审核通过的方案如下，请严格按此实现：")) return "我已通过开发方案。";
    if (text.startsWith("请审查本任务当前代码差异。")) return "我已验收开发结果，开始 Code Review。";
    if (text.startsWith("工作台发布重试指令：")) return "我已发起发布重试。";
    if (text.startsWith("工作台自动发布指令：")) return "我已确认并发起发布流程。";
    const fixRequest = text.indexOf("整改要求：");
    if (text.startsWith("风险 ") && fixRequest >= 0) text = text.slice(fixRequest + "整改要求：".length).trim();
  }

  try {
    const payload = JSON.parse(text);
    if (["plan_ready", "development_complete", "review_complete", "fix_complete", "apifox_updated"].includes(payload?.type)) return "";
  } catch {}
  return text;
}

function visibleStreamText(text) {
  const marker = "WORKFLOW_EVENT:";
  return text.split("\n").filter((line, index, lines) => {
    const content = line.trimStart();
    if (content.startsWith(marker) && /^\s*\{/.test(content.slice(marker.length))) return false;
    return index !== lines.length - 1 || !content || (!marker.startsWith(content) && !/^WORKFLOW_EVENT:\s*$/.test(content));
  }).join("\n").trimEnd();
}

const executionDetailsState = new Map();
document.addEventListener("toggle", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLDetailsElement) || !element.dataset.executionKey || !element.isConnected) return;
  executionDetailsState.set(element.dataset.executionKey, element.open);
}, true);

function executionStepLabelHTML(step) {
  const fields = [
    ["原始命令", step.command],
    ["调用参数", step.arguments],
    ["输出", step.output],
    ["错误", step.error],
  ].filter(([, value]) => value);
  if (step.exitCode != null) fields.push(["退出码", String(step.exitCode)]);
  if (!fields.length) {
    const fileChange = step.label?.startsWith("修改文件：");
    const label = fileChange ? step.label.slice("修改文件：".length) : step.label;
    return `<span class="${fileChange ? "execution-file-change" : ""}">${fileChange ? `<span class="execution-action-label">修改文件</span><span class="execution-file-paths">${escapeHTML(label).replace(/、/g, ", ")}</span>` : escapeHTML(label)}</span>`;
  }

  const key = `step:${state.selected?.id}:${step.id}`;
  return `<details class="execution-command" data-execution-key="${escapeHTML(key)}" ${executionDetailsState.get(key) ? "open" : ""}><summary>${escapeHTML(step.label)}</summary>${fields.map(([label, value]) => `<div class="execution-field"><span>${label}</span><pre>${escapeHTML(value)}</pre></div>`).join("")}</details>`;
}

function executionStepsHTML(message) {
  if (!message.steps?.length) return "";
  const renderStep = (step, showDetails) => `<div class="execution-step"><span class="execution-step-state ${escapeHTML(step.status)}">${step.status === "running" && message.streaming ? "◌" : step.status === "failed" ? "!" : step.status === "running" ? "·" : "✓"}</span>${showDetails ? executionStepLabelHTML(step) : escapeHTML(step.label)}</div>`;
  const key = `group:${state.selected?.id}:${message.steps[0].id}`;
  const expanded = executionDetailsState.get(key) ?? message.streaming;
  return `<details class="execution-steps" data-execution-key="${escapeHTML(key)}" ${expanded ? "open" : ""}><summary>${message.streaming ? "正在执行" : "执行步骤"} · ${message.steps.length} 项</summary><div class="execution-step-preview">${renderStep(message.steps.at(-1), false)}</div><div class="execution-step-list">${message.steps.map((step) => renderStep(step, true)).join("")}</div></details>`;
}

function conversationHTML() {
  return state.conversation.map((message) => ({
    message,
    text: conversationText(message),
  }))
    .filter(({ message, text }) => text || message.streaming || message.steps?.length)
    .map(({ message, text }) => message.role === "system" ? `<div class="conversation-notice" role="status">${escapeHTML(text)}</div>` : `<div class="conversation-message ${message.role === "user" ? "user" : "codex"}${message.streaming ? " streaming" : ""}">
    ${message.role === "user" ? "" : `<div class="conversation-role">Codex</div>`}${executionStepsHTML(message)}${text ? `<div class="conversation-text">${renderMarkdown(text)}</div>` : ""}${message.streaming ? `<div class="codex-activity"><span class="activity-orb"></span><span class="activity-label">${escapeHTML(message.activity || "思考中")}</span><span class="activity-dots"><i></i><i></i><i></i></span></div>` : ""}
  </div>`).join("") + userInputHTML();
}

function isQuestionAnswerPrompt(text = "") {
  return text.split("\nUser request or context:\n", 1)[0].split("\n").some((line) => line.startsWith("Phase: plan_qa."));
}

function workModeKey(task) {
  return task.phase === "development"
    ? `workflow.workMode.${task.id}.development`
    : `workflow.workMode.${task.id}`;
}

function selectedWorkMode(task) {
  const phase = displayPhase(task.phase);
  if (phase === "development") return localStorage.getItem(workModeKey(task)) === "plan" ? "plan" : "default";
  if (phase === "plan") return localStorage.getItem(workModeKey(task)) === "default" ? "default" : "plan";
  return "default";
}

function deferredPlanApproval(task) {
  const approvalID = task.approval?.id;
  return approvalID && localStorage.getItem(`workflow.deferredPlanApproval.${task.id}`) === approvalID
    ? approvalID : "";
}

function recoverablePlanReply(task) {
  if (task?.phase !== "plan" || task.status !== "waiting_user" || isCodexActive()) return "";
  const lastUser = state.conversation.findLast((message) => message.role === "user");
  if (isQuestionAnswerPrompt(lastUser?.text)) return "";
  const message = state.conversation.at(-1);
  if (message?.role !== "codex" || message.streaming) return "";
  const reply = message.rawText || message.text || "";
  const marker = reply.match(/^\s*WORKFLOW_EVENT:\s*(\{.*\})\s*$/m);
  if (!marker) return "";
  const plan = visibleStreamText(reply).trim();
  if (!plan || plan === task.result?.summary) return "";
  try {
    return JSON.parse(marker[1]).type === "plan_ready" ? reply : "";
  } catch {
    return "";
  }
}

function planReviewHTML() {
  const task = state.selected;
  if (!task || displayPhase(task.phase) !== "plan" || isArchived(task) || selectedWorkMode(task) !== "plan") return "";
  if (state.sendingMessage || isCodexActive()) return "";
  if (deferredPlanApproval(task)) return "";
  if (!task.approval && !recoverablePlanReply(task)) return "";
  const disabled = state.submittingApproval === task.id ? "disabled" : "";
  return `<section class="approval-card plan-review-card" aria-label="方案审核">
    ${state.conversationError && task.result?.summary ? `<div class="conversation-text">${renderMarkdown(task.result.summary)}</div>` : ""}
    <h3>确认此方案并开始开发，还是需要修改？</h3>
    <textarea id="approvalComment" aria-label="方案修改意见" rows="2" placeholder="要求修改时，请填写修改意见" ${disabled}>${escapeHTML(state.approvalDraft)}</textarea>
    <div class="modal-actions"><button type="button" class="button" data-plan-approval="request_changes" ${disabled}>要求修改</button>
    <button type="button" class="button primary" data-plan-approval="approve" ${disabled}>确认并开发</button></div>
  </section>`;
}

function userInputHTML() {
  const request = state.pendingUserInput;
  if (!request) return "";
  const questions = request.questions || [];
  const approval = request.kind === "approval";
  return `<form id="userInputForm" class="user-input-card"><div class="user-input-title">${approval ? "Codex 请求确认" : "Codex 需要你补充信息"}</div>
    ${questions.map((question, index) => `<fieldset class="user-input-question"><legend>${question.header ? `<span class="user-input-header">${escapeHTML(question.header)}</span>` : ""}${escapeHTML(question.question)}</legend>
      ${(question.options || []).map((option) => `<label class="user-input-option"><input type="radio" name="answer-${index}" value="${escapeHTML(option.label)}" ${state.answeringUserInput ? "disabled" : ""}><span><strong>${escapeHTML(option.label)}</strong>${option.description ? `<small>${escapeHTML(option.description)}</small>` : ""}</span></label>`).join("")}
      ${question.isOther ? `<label class="user-input-option"><input type="radio" name="answer-${index}" value="__other__" ${state.answeringUserInput ? "disabled" : ""}><span><strong>${approval ? "提交表单" : "其他"}</strong><small>${approval ? "填写 JSON 对象" : "填写自己的答案"}</small></span></label><textarea data-other-answer="${index}" rows="2" placeholder="${approval ? "输入 JSON 对象" : "输入其他答案"}" hidden ${state.answeringUserInput ? "disabled" : ""}></textarea>` : ""}
      ${(question.options || []).length === 0 && !question.isOther ? `<textarea data-free-answer="${index}" rows="2" placeholder="填写答案" ${state.answeringUserInput ? "disabled" : ""}></textarea>` : ""}
    </fieldset>`).join("")}
    <div class="user-input-actions"><span class="user-input-error" role="alert"></span><button type="submit" class="button primary" ${state.answeringUserInput ? "disabled" : ""}>${state.answeringUserInput ? "正在提交…" : "提交选择"}</button></div></form>`;
}

function renderConversation(forceBottom = false, restoredTop = null) {
  updateSendButton();
  const mode = $("#codexWorkMode");
  if (mode) mode.disabled = isCodexActive() || state.sendingMessage || state.codexRestarting || Boolean(state.pendingUserInput);
  const list = document.querySelector(".conversation-list");
  if (!list) return;
  const previousTop = list.scrollTop;
  const atBottom = list.scrollHeight - list.clientHeight - previousTop < 16;
  list.innerHTML = state.conversationError
    ? `<div class="form-error">无法从 Codex 读取会话：${escapeHTML(state.conversationError)}</div>`
    : conversationHTML() || (state.conversationLoading ? '<div class="task-sub">正在加载会话…</div>' : '<div class="task-sub">会话中暂无消息</div>');
  if (state.codexRestarting) {
    list.insertAdjacentHTML("beforeend", '<div class="conversation-message codex" role="status"><div class="conversation-role">Codex</div><div class="codex-activity"><span class="activity-orb"></span><span class="activity-label">正在启动 Codex 并恢复历史会话，消息会在连接成功后继续…</span><span class="activity-dots"><i></i><i></i><i></i></span></div></div>');
  } else if (state.sendingMessage) {
    list.insertAdjacentHTML("beforeend", '<div class="conversation-message codex" role="status"><div class="conversation-role">Codex</div><div class="codex-activity"><span class="activity-orb"></span><span class="activity-label">消息已提交，正在连接 Codex 并等待开始处理…</span><span class="activity-dots"><i></i><i></i><i></i></span></div></div>');
  }
  list.insertAdjacentHTML("beforeend", planReviewHTML());
  const approvalComment = list.querySelector("#approvalComment");
  approvalComment?.addEventListener("input", () => {
    state.approvalDraft = approvalComment.value;
    approvalComment.setCustomValidity("");
  });
  list.querySelectorAll("[data-plan-approval]").forEach((button) => {
    button.addEventListener("click", () => sendApproval(button.dataset.planApproval));
  });
  const messageInput = $("#messageInput");
  if (messageInput) messageInput.disabled = messageInput.dataset.phaseGated === "true" || Boolean(state.pendingUserInput);
  list.querySelector("#userInputForm")?.addEventListener("submit", submitUserInput);
  list.querySelectorAll("#userInputForm textarea").forEach((field) => field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }));
  list.querySelectorAll("[data-other-answer]").forEach((field) => field.addEventListener("input", () => {
    const index = field.dataset.otherAnswer;
    const option = list.querySelector(`input[name="answer-${index}"][value="__other__"]`);
    field.hidden = false;
    if (field.value) option.checked = true;
  }));
  list.querySelectorAll('.user-input-question input[type="radio"]').forEach((option) => option.addEventListener("change", () => {
    const index = option.name.replace("answer-", "");
    const field = list.querySelector(`[data-other-answer="${index}"]`);
    if (field) field.hidden = option.value !== "__other__";
  }));
  list.scrollTop = forceBottom ? list.scrollHeight : restoredTop ?? (atBottom ? list.scrollHeight : previousTop);
}

function stopConversationStream() {
  state.codexRestarting = false;
  state.codexActive = null;
  state.pendingUserInput = null;
  state.answeringUserInput = false;
  state.conversationStream?.close();
  state.conversationStream = null;
  state.activeStreamMessage = null;
}

function startConversationStream(taskID) {
  stopConversationStream();
  const stream = new EventSource(`/api/tasks/${taskID}/conversation/events`);
  state.conversationStream = stream;
  let pendingRender = 0;
  stream.addEventListener("conversation", (event) => {
    if (state.selected?.id !== taskID || state.conversationStream !== stream) return;
    let update;
    try {
      update = JSON.parse(event.data)?.data;
    } catch {
      return;
    }
    if (!update) return;
    state.conversationError = "";
    if (update.type === "process_exited") {
      state.codexActive = false;
      state.codexRestarting = false;
      state.sendingMessage = false;
      state.stoppingTaskID = null;
      state.conversation.forEach((message) => { message.streaming = false; });
      state.activeStreamMessage = null;
      state.conversation.push({ role: "codex", text: update.text || "Codex 进程已退出，发送消息以恢复" });
      void refreshSelectedTask(taskID);
    } else if (update.type === "restarting") {
      state.codexRestarting = update.restarting;
    } else if (update.type === "user_input_requested") {
      state.pendingUserInput = update.userInput || null;
      state.answeringUserInput = false;
    } else if (update.type === "user_input_answered") {
      state.pendingUserInput = null;
      state.answeringUserInput = false;
    } else if (update.type === "turn_started") {
      state.sendingMessage = false;
      state.codexRestarting = false;
      state.codexActive = true;
      if (state.activeStreamMessage?.streaming) {
        state.activeStreamMessage.activity ||= "思考中";
      } else {
        state.conversation.forEach((message) => {
          if (message.role === "codex" && message.streaming) message.streaming = false;
        });
        state.activeStreamMessage = {
          role: "codex",
          text: "",
          rawText: "",
          activity: "思考中",
          streaming: true,
        };
        state.conversation.push(state.activeStreamMessage);
      }
    } else if (update.type === "turn_snapshot") {
      const activeMessage = state.activeStreamMessage;
      const lastMessage = activeMessage || state.conversation.at(-1);
      state.codexRestarting = update.restarting === true;
      state.codexActive = !update.completed;
      if (update.completed) {
        state.sendingMessage = false;
        state.conversation.forEach((message) => { message.streaming = false; });
        state.activeStreamMessage = null;
        state.stoppingTaskID = null;
      }
      const visibleText = visibleStreamText(update.text || "");
      if (lastMessage?.role === "codex" && (activeMessage || lastMessage.text === visibleText || (visibleText && visibleText.startsWith(lastMessage.text)))) {
        lastMessage.rawText = update.text || "";
        lastMessage.text = visibleText;
        lastMessage.streaming = !update.completed;
        lastMessage.steps = update.steps || lastMessage.steps || [];
        state.activeStreamMessage = update.completed ? null : lastMessage;
      } else if (visibleText || !update.completed) {
        state.activeStreamMessage = {
          role: "codex",
          text: visibleText,
          rawText: update.text || "",
          steps: update.steps || [],
          streaming: !update.completed,
        };
        state.conversation.push(state.activeStreamMessage);
      }
    } else if (update.type === "step") {
      if (!state.activeStreamMessage) {
        state.activeStreamMessage = { role: "codex", text: "", rawText: "", streaming: true, steps: [] };
        state.conversation.push(state.activeStreamMessage);
      }
      const steps = state.activeStreamMessage.steps ||= [];
      if (update.step) {
        const index = steps.findIndex((step) => step.id === update.step.id);
        if (index >= 0) steps[index] = update.step;
        else steps.push(update.step);
        state.activeStreamMessage.activity = update.step.command ? "正在执行命令" : update.step.label;
      }
    } else if (update.type === "delta") {
      state.codexActive = true;
      if (!state.activeStreamMessage) {
        state.activeStreamMessage = {
          role: "codex",
          text: "",
          rawText: "",
          streaming: true,
        };
        state.conversation.push(state.activeStreamMessage);
      }
      state.activeStreamMessage.rawText += update.text || "";
      state.activeStreamMessage.text = visibleStreamText(state.activeStreamMessage.rawText);
      state.activeStreamMessage.activity = update.activity || "行动中";
    } else if (update.type === "turn_completed") {
      state.codexActive = false;
      state.sendingMessage = false;
      state.stoppingTaskID = null;
      state.pendingUserInput = null;
      state.answeringUserInput = false;
      if (!state.activeStreamMessage && visibleStreamText(update.text || "")) {
        state.activeStreamMessage = { role: "codex" };
        state.conversation.push(state.activeStreamMessage);
      }
      if (state.activeStreamMessage) {
        state.activeStreamMessage.streaming = false;
        if (update.text) {
          state.activeStreamMessage.rawText = update.text;
          state.activeStreamMessage.text = visibleStreamText(update.text);
        }
      }
      state.activeStreamMessage = null;
      if (update.status === "interrupted" && !(state.conversation.at(-1)?.role === "codex" && state.conversation.at(-1)?.text === "用户已终止")) {
        state.conversation.push({ role: "codex", text: "用户已终止" });
      }
      renderConversation();
      window.setTimeout(() => refreshSelectedTask(taskID), 300);
      return;
    }
    if (!pendingRender) {
      pendingRender = requestAnimationFrame(() => {
        pendingRender = 0;
        if (state.conversationStream === stream) renderConversation();
      });
    }
  });
}

function isCodexActive() {
  return state.codexActive ?? (state.selected?.codexActive === true);
}

function updateSendButton() {
  const button = $("#sendMessage");
  if (!button) return;
  const active = isCodexActive();
  if (state.codexRestarting) {
    button.disabled = true;
    button.textContent = "↑";
    button.setAttribute("aria-label", "Codex 服务正在重新启动");
    button.title = "Codex 服务正在重新启动…";
    return;
  }
  if (state.sendingMessage) {
    button.disabled = true;
    button.textContent = "↑";
    button.setAttribute("aria-label", state.codexRestarting ? "正在恢复 Codex 会话" : "正在连接 Codex");
    button.title = state.codexRestarting ? "正在恢复 Codex 会话，消息已提交" : "消息已提交，正在等待 Codex 开始处理";
    return;
  }
  if (active) {
    button.disabled = state.stoppingTaskID === state.selected?.id;
    button.innerHTML = '<span class="stop-icon" aria-hidden="true"></span>';
    button.setAttribute("aria-label", button.disabled ? "正在终止 Codex" : "终止 Codex 执行");
    button.title = button.disabled ? "正在终止…" : "终止 Codex 执行";
  } else {
    button.disabled = button.dataset.gated === "true";
    button.textContent = "↑";
    button.setAttribute("aria-label", "发送消息");
    button.title = "发送消息";
  }
}

async function stopCodex() {
  const taskID = state.selected?.id;
  if (!taskID || state.stoppingTaskID === taskID) return;
  state.stoppingTaskID = taskID;
  updateSendButton();
  try {
    await api(`/api/tasks/${taskID}/stop`, { method: "POST" });
  } catch (error) {
    if (state.selected?.id === taskID) {
      state.stoppingTaskID = null;
      updateSendButton();
      alert(error.message);
    }
  }
}

function appendUserMessage(text) {
  const message = {
    role: "user",
    text,
  };
  state.conversation.push(message);
  renderConversation(true);
  return message;
}

function removeConversationMessage(message) {
  state.conversation = state.conversation.filter((item) => item !== message);
  renderConversation();
}

function renderInlineMarkdown(value) {
  const code = [];
  let html = escapeHTML(value).replace(/`([^`]+)`/g, (_, text) => {
    const token = `\u0000${code.length}\u0000`;
    code.push(`<code>${text}</code>`);
    return token;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) =>
    `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)] || "");
}

function markdownTableCells(line) {
  const cells = line.trim().split(/(?<!\\)\|/);
  if (cells.length < 2) return [];
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function renderMarkdownTable(headers, separators, rows) {
  const alignments = separators.map((separator) => {
    if (separator.startsWith(":") && separator.endsWith(":")) return "center";
    return separator.endsWith(":") ? "right" : "left";
  });
  const renderCells = (cells, tag) => cells.map((cell, index) =>
    `<${tag} class="align-${alignments[index]}"${tag === "th" ? ' scope="col"' : ""}>${renderInlineMarkdown(cell)}</${tag}>`).join("");
  return `<div class="markdown-table"><table><thead><tr>${renderCells(headers, "th")}</tr></thead><tbody>${rows.map((row) => `<tr>${renderCells(row, "td")}</tr>`).join("")}</tbody></table></div>`;
}

function renderMarkdown(value) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listType}>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listType}>`);
    list = [];
    listType = "";
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      if (inCode) {
        blocks.push(`<pre><code>${escapeHTML(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const separators = markdownTableCells(lines[index + 1] || "");
    if (separators.length && separators.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const headers = markdownTableCells(line);
      if (headers.length === separators.length) {
        flushParagraph();
        flushList();
        const rows = [];
        index++;
        while (index + 1 < lines.length) {
          const row = markdownTableCells(lines[index + 1]);
          if (row.length !== headers.length) break;
          rows.push(row);
          index++;
        }
        blocks.push(renderMarkdownTable(headers, separators, rows));
        continue;
      }
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const item = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
    } else if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
    } else if (item) {
      flushParagraph();
      const nextListType = /^\s*\d/.test(line) ? "ol" : "ul";
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      list.push(item[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (inCode) blocks.push(`<pre><code>${escapeHTML(code.join("\n"))}</code></pre>`);
  return blocks.join("");
}

function isCompleted(task) {
  return task.phase === "done" || task.status === "completed";
}

function isArchived(task) {
  return task.status === "archived" || Boolean(task.archivedAt);
}

function needsUserAction(task) {
  if (task.approval || task.status === "waiting_approval") return true;
  if (task.codexActive && task.status !== "persistence_error") return false;
  if (["dev_review", "risk_review"].includes(task.phase) && task.status === "waiting_user") return true;
  return ["paused", "needs_review", "release_failed", "persistence_error", "codex_error"].includes(task.status);
}

function taskState(task) {
  if (isArchived(task)) return ["已归档", "archived", "—"];
  if (isCompleted(task)) return ["已完成", "done", "✓"];
  if (task.codexActive && !needsUserAction(task)) return ["进行中", "running", "↻"];
  if (task.status === "paused") return ["已暂停", "paused", "Ⅱ"];
  if (task.status === "codex_error") return ["Codex 连接失败", "error", "!"];
  if (task.status === "release_failed") return ["发布暂停", "error", "!"];
  if (task.status === "persistence_error") return ["状态保存失败", "error", "!"];
  if (needsUserAction(task)) return ["等待我处理", "waiting", "◷"];
  return ["进行中", "running", "↻"];
}

function timeAgo(value) {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

async function refreshTasks() {
  if (state.tasksRefreshing) return;
  state.tasksRefreshing = true;
  try {
    const result = await api("/api/tasks");
    state.tasks = result?.list || [];
    $("#globalError").classList.add("hidden");
    renderRows();
  } catch (error) {
    $("#globalError").textContent = `无法读取工作台数据：${error.message}`;
    $("#globalError").classList.remove("hidden");
    setConnection("mysql", "error");
  } finally {
    state.tasksRefreshing = false;
  }
}

window.setInterval(() => {
  if (!document.hidden && !state.selected) void refreshTasks();
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.selected) void refreshTasks();
});

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    setConnection("codex", status.connections.codex);
    setConnection("mysql", status.connections.mysql);
  } catch {
    setConnection("mysql", "error");
  }
}

function setConnection(name, value) {
  const label = $(`#${name}State`);
  const dot = $(`#${name}Dot`);
  label.textContent = value === "online" ? "在线"
    : value === "available" ? "命令可用"
      : value === "unavailable" ? "不可用"
        : value === "error" ? "连接错误" : "检测中";
  dot.className = value === "online" ? "" : value === "available" ? "warn" : "fail";
}

function renderRows() {
  const tasks = state.tasks.filter((task) => {
    if (state.filter === "archived") return isArchived(task);
    if (isArchived(task)) return false;
    if (state.filter === "waiting") return needsUserAction(task);
    if (state.filter === "done") return isCompleted(task);
    if (state.filter === "running") return !isCompleted(task) && !needsUserAction(task);
    return true;
    }).sort((a, b) => {
      const aWaiting = needsUserAction(a) ? 1 : 0;
      const bWaiting = needsUserAction(b) ? 1 : 0;
    return bWaiting - aWaiting || (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0);
	});
  $("#taskCount").textContent = `${tasks.length} 个任务`;
  const activeTasks = state.tasks.filter((task) => !isArchived(task));
  const runningCount = activeTasks.filter((task) => !isCompleted(task) && !needsUserAction(task)).length;
  $("#runningCount").textContent = runningCount;
  $("#runningCount").classList.toggle("hidden", runningCount === 0);
  const waitingCount = activeTasks.filter(needsUserAction).length;
  $("#waitingCount").textContent = waitingCount;
  $("#waitingCount").classList.toggle("hidden", waitingCount === 0);
  const rows = $("#taskRows");
  const existing = new Map([...rows.querySelectorAll(".task-row")].map((row) => [row.dataset.id, row]));
  tasks.forEach((task, index) => {
    const [label, style, icon] = taskState(task);
    let row = existing.get(task.id);
    if (!row) {
      const template = document.createElement("template");
      template.innerHTML = '<div class="task-row" role="button" tabindex="0"><span><div class="task-name"></div><div class="task-sub"></div></span><span class="repo"></span><span class="phase"></span><span class="state"><i></i><span class="state-label"></span></span><span class="time"></span><span class="row-arrow">›</span></div>';
      row = template.content.firstElementChild;
      row.dataset.id = task.id;
      row.addEventListener("click", () => openTask(row.dataset.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTask(row.dataset.id); }
      });
    }
    row.setAttribute("aria-label", `打开任务：${task.title}`);
    row.querySelector(".task-name").textContent = task.title;
    row.querySelector(".task-sub").textContent = `创建于 ${timeAgo(task.createdAt)}`;
    const repository = row.querySelector(".repo");
    repository.textContent = task.repositoryPath;
    repository.title = task.repositoryPath;
    row.querySelector(".phase").textContent = phaseLabels[displayPhase(task.phase)] || task.phase;
    const status = row.querySelector(".state");
    status.className = `state ${style}`;
    status.querySelector("i").textContent = icon;
    status.querySelector(".state-label").textContent = label;
    row.querySelector(".time").textContent = timeAgo(task.updatedAt);
    const currentAtIndex = rows.children[index];
    if (currentAtIndex !== row) rows.insertBefore(row, currentAtIndex || null);
    existing.delete(task.id);
  });
  existing.forEach((row) => row.remove());
  $("#empty").classList.toggle("hidden", tasks.length !== 0);
  $("#taskRows").classList.toggle("hidden", tasks.length === 0);
  if (tasks.length === 0 && state.tasks.length > 0) {
    $("#empty h3").textContent = "没有符合条件的任务";
    $("#empty p").textContent = "换一个筛选条件，或创建任务。";
    $("#emptyNew").textContent = "创建任务";
  } else {
    $("#empty h3").textContent = "从一个开发任务开始";
    $("#empty p").textContent = "选择本地仓库并描述需求，工作台会把任务交给 Codex。";
    $("#emptyNew").textContent = "创建任务";
  }
  document.querySelectorAll(".filter").forEach((item) => {
    item.setAttribute("aria-selected", String(item.dataset.filter === state.filter));
  });
}

async function openTask(id) {
  stopConversationStream();
  try {
    state.selected = await api(`/api/tasks/${id}`);
    state.conversation = [];
    state.conversationError = "";
    state.conversationLoading = true;
    state.codexModelsLoading = !state.codexModels.length;
    showTaskWorkspace();
    renderWorkspace();
    startConversationStream(id);
    void loadTaskConversation(id);
    if (!state.codexModels.length) void loadCodexModels();
  } catch (error) {
    alert(error.message);
  }
}

async function loadTaskConversation(id, { manual = false } = {}) {
  try {
    const conversation = await api(`/api/tasks/${id}/conversation`);
    if (state.selected?.id !== id) return;
    const active = state.activeStreamMessage;
    if (active?.streaming) {
      const last = conversation.at(-1);
      if (last?.role === "codex" && (last.text === active.text || (active.text && active.text.startsWith(last.text)))) conversation.pop();
      conversation.push(active);
    }
    state.conversation = conversation;
    state.conversationError = "";
  } catch (error) {
    if (state.selected?.id !== id) return;
    if (manual) throw error;
    state.conversation = [];
    state.conversationError = error.message;
  } finally {
    if (state.selected?.id === id) {
      state.conversationLoading = false;
      renderConversation();
    }
  }
}

async function loadCodexModels() {
  try {
    const modelData = await api("/api/codex/models");
    state.codexModels = modelData.list || [];
    const defaultEntry = state.codexModels.find((model) => model.isDefault) || state.codexModels[0];
    state.codexDefaultModel = defaultEntry?.model || defaultEntry?.id || "";
    if (!selectedCodexModel()) state.selectedModel = state.codexDefaultModel;
  } catch {
    // Model discovery is optional for opening a task; the selector can use its fallback.
  } finally {
    state.codexModelsLoading = false;
    if (state.selected) renderWorkspace();
  }
}

const reasoningEffortLabels = {
  none: "关闭", minimal: "最低", low: "轻度", medium: "中",
  high: "高", xhigh: "极高", max: "Max", ultra: "Ultra",
};

function selectedCodexModel() {
  return state.codexModels.find((model) => (model.model || model.id) === state.selectedModel);
}

function modelEfforts(model) {
  return (model?.supportedReasoningEfforts || []).map((option) => option.reasoningEffort).filter(Boolean);
}

function selectedReasoningEffort(model, efforts = modelEfforts(model)) {
  if (!efforts.length) return "";
  const saved = localStorage.getItem(`workflow.reasoningEffort.${model.model || model.id}`);
  if (efforts.includes(saved)) return saved;
  return efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0];
}

function fastServiceTier(model) {
  return model?.serviceTiers?.find((tier) => tier.id === "priority");
}

function turnPreferences() {
  const model = selectedCodexModel();
  return {
    model: state.selectedModel,
    reasoningEffort: selectedReasoningEffort(model),
    serviceTier: state.speedMode === "priority" && fastServiceTier(model) ? "priority" : "default",
  };
}

function effortPosition(index, count) {
  return `${count > 1 ? (index / (count - 1)) * 100 : 50}%`;
}

function modelPickerHTML(model, disabled) {
  const efforts = modelEfforts(model);
  const effort = selectedReasoningEffort(model, efforts);
  const effortIndex = efforts.indexOf(effort);
  const effortLabel = escapeHTML(reasoningEffortLabels[effort] || effort);
  const modelLabel = state.codexModelsLoading ? "模型正在加载…" : (model?.displayName || model?.name || model?.model || model?.id || "Codex 默认模型");
  if (disabled) state.modelMenuOpen = false;
  const menu = disabled ? "" : `<div class="model-picker-menu" id="modelPickerMenu" ${state.modelMenuOpen ? "" : "hidden"}>
    ${effort ? `<div class="model-effort">
      <div class="model-effort-heading"><label for="modelReasoningEffort">推理强度</label><strong id="modelEffortValue">${effortLabel}</strong></div>
      <input type="range" id="modelReasoningEffort" min="0" max="${efforts.length - 1}" step="any" value="${effortIndex}" aria-valuetext="${effortLabel}" style="--effort-progress: ${effortPosition(effortIndex, efforts.length)}" ${efforts.length === 1 ? "disabled" : ""}>
      <div class="model-effort-scale" aria-label="推理强度档位">${efforts.map((value, index) => `<button type="button" class="model-effort-stop ${index === effortIndex ? "active" : ""}" data-effort-stop="${index}" style="--effort-stop: ${effortPosition(index, efforts.length)}" aria-label="${escapeHTML(reasoningEffortLabels[value] || value)}" aria-pressed="${index === effortIndex}"><span>${escapeHTML(reasoningEffortLabels[value] || value)}</span></button>`).join("")}</div>
    </div>` : ""}
    <div class="model-picker-list" role="group" aria-label="可用模型">${state.codexModels.map((entry) => {
      const id = entry.model || entry.id;
      const label = entry.displayName || entry.name || id;
      return `<button type="button" class="model-picker-item" data-model="${escapeHTML(id)}" aria-pressed="${id === state.selectedModel}">${escapeHTML(label)}${entry.isDefault ? " · 默认" : ""}</button>`;
    }).join("")}</div>
  </div>`;
  return `<div class="model-picker"><button type="button" class="model-picker-button" id="toggleModelMenu" title="选择模型和推理强度" aria-expanded="${Boolean(state.modelMenuOpen)}" ${disabled ? "disabled" : 'aria-controls="modelPickerMenu"'}><span class="model-picker-icon" aria-hidden="true">✦</span><span>${escapeHTML(modelLabel)}</span>${effort ? `<span class="model-picker-effort" id="selectedModelEffort">${effortLabel}</span>` : ""}</button>${menu}</div>`;
}

function positionModelMenu() {
  const menu = $("#modelPickerMenu");
  if (!menu || menu.hidden) return;
  const anchorLeft = menu.parentElement.getBoundingClientRect().left;
  const maxLeft = document.documentElement.clientWidth - menu.offsetWidth - 8;
  menu.style.left = `${Math.max(8, Math.min(anchorLeft, maxLeft)) - anchorLeft}px`;
}

function setModelMenuOpen(open) {
  const menu = $("#modelPickerMenu");
  if (!menu) return;
  state.modelMenuOpen = open;
  menu.hidden = !open;
  $("#toggleModelMenu").setAttribute("aria-expanded", String(open));
  if (open) positionModelMenu();
}

function confirmUltra() {
  const dialog = $("#ultraWarning");
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "enable"), { once: true });
    dialog.showModal();
  });
}

function bindModelEffortSlider(model) {
  const slider = $("#modelReasoningEffort");
  if (!slider || slider.disabled) return;
  const efforts = modelEfforts(model);
  const valueLabel = $("#modelEffortValue");
  const buttonLabel = $("#selectedModelEffort");
  const stops = document.querySelectorAll(".model-effort-stop");
  const preferenceKey = `workflow.reasoningEffort.${model.model || model.id}`;
  let snapFrame = 0;

  const cancelSnap = () => {
    cancelAnimationFrame(snapFrame);
    snapFrame = 0;
  };
  const paintTrack = () => slider.style.setProperty("--effort-progress", effortPosition(slider.valueAsNumber, efforts.length));
  const paintStop = (index) => {
    const effort = efforts[index];
    const label = reasoningEffortLabels[effort] || effort;
    slider.setAttribute("aria-valuetext", label);
    valueLabel.textContent = label;
    stops.forEach((stop, stopIndex) => {
      stop.classList.toggle("active", stopIndex === index);
      stop.setAttribute("aria-pressed", String(stopIndex === index));
    });
    return label;
  };
  const setPosition = (position) => {
    slider.valueAsNumber = position;
    paintTrack();
  };
  const selectStop = (index) => {
    localStorage.setItem(preferenceKey, efforts[index]);
    buttonLabel.textContent = paintStop(index);
  };

  const snapTo = (index, animate) => {
    cancelSnap();
    const position = slider.valueAsNumber;
    if (!animate || position === index || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPosition(index);
      return;
    }
    const start = performance.now();
    const settle = (now) => {
      snapFrame = 0;
      if (!slider.isConnected) return;
      const elapsed = Math.min(1, (now - start) / 140);
      const progress = 1 - (1 - elapsed) ** 3;
      setPosition(position + (index - position) * progress);
      if (elapsed < 1) snapFrame = requestAnimationFrame(settle);
    };
    snapFrame = requestAnimationFrame(settle);
  };
  const chooseStop = async (index, animate) => {
    const previous = efforts.indexOf(selectedReasoningEffort(model, efforts));
    snapTo(index, animate);
    if (efforts[index] === "ultra" && index !== previous) {
      const taskID = state.selected?.id;
      slider.disabled = true;
      paintStop(index);
      const confirmed = await confirmUltra();
      if (!slider.isConnected) {
        if (confirmed && state.selected?.id === taskID && selectedCodexModel() === model) {
          localStorage.setItem(preferenceKey, "ultra");
          renderWorkspace();
        }
        return;
      }
      slider.disabled = false;
      if (!$("#modelPickerMenu").hidden) slider.focus({ preventScroll: true });
      if (!confirmed) {
        paintStop(previous);
        snapTo(previous, true);
        return;
      }
    }
    selectStop(index);
  };

  slider.addEventListener("pointerdown", cancelSnap);
  slider.addEventListener("input", () => {
    cancelSnap();
    paintTrack();
    paintStop(Math.round(slider.valueAsNumber));
  });
  slider.addEventListener("change", () => {
    void chooseStop(Math.round(slider.valueAsNumber), true);
  });
  stops.forEach((stop) => stop.addEventListener("click", () => {
    void chooseStop(Number(stop.dataset.effortStop), true);
  }));
  slider.addEventListener("keydown", (event) => {
    const current = Math.round(slider.valueAsNumber);
    const last = efforts.length - 1;
    const targets = {
      ArrowLeft: current - 1, ArrowDown: current - 1, ArrowRight: current + 1, ArrowUp: current + 1,
      PageDown: current - 2, PageUp: current + 2, Home: 0, End: last,
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    void chooseStop(Math.max(0, Math.min(last, targets[event.key])), false);
  });
}

document.addEventListener("pointerdown", (event) => {
  if (state.modelMenuOpen && !event.target.closest(".model-picker, .speed-confirm, #ultraWarning")) setModelMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.modelMenuOpen || $("#ultraWarning").open || $(".speed-confirm:popover-open")) return;
  setModelMenuOpen(false);
  $("#toggleModelMenu")?.focus();
});
window.addEventListener("resize", positionModelMenu);

function initialTaskMessage(data) {
  return `需求：\n${String(data.requirement || "").trim()}\n\n用户期望的实现方式：\n${String(data.implementationApproach || "").trim()}`;
}

function showTaskWorkspace() {
  const rememberedSidebarWidth = Number(localStorage.getItem("workflow.sidebarWidth"));
  if (window.innerWidth > 800) setWorkspaceSidebarWidth(rememberedSidebarWidth > 0 ? rememberedSidebarWidth : 280);
  document.body.classList.add("workspace-active");
  $("#listPage").classList.add("hidden");
  $("#workspacePage").classList.remove("hidden");
  $("#pageTitle").textContent = "任务工作区";
}

async function refreshSelectedTask(taskID, { manual = false } = {}) {
  if (state.selected?.id !== taskID) return;
  try {
    const task = await api(`/api/tasks/${taskID}`);
    if (state.selected?.id !== taskID) return;
    state.selected = task;
    renderWorkspace();
  } catch (error) {
    if (manual) throw error;
    // The task view remains usable if a single refresh fails.
  }
}

async function refreshWorkspace() {
  const taskID = state.selected?.id;
  if (!taskID || state.refreshingTaskID === taskID) return;
  state.refreshingTaskID = taskID;
  const button = $("#refreshWorkspace");
  button.disabled = true;
  button.innerHTML = '<span class="refresh-icon is-spinning" aria-hidden="true">↻</span>';
  button.setAttribute("aria-label", "刷新中");
  const results = await Promise.allSettled([
    refreshSelectedTask(taskID, { manual: true }),
    loadTaskConversation(taskID, { manual: true }),
  ]);
  if (state.refreshingTaskID === taskID) state.refreshingTaskID = null;
  if (state.selected?.id !== taskID) return;
  const currentButton = $("#refreshWorkspace");
  currentButton.disabled = false;
  currentButton.innerHTML = '<span class="refresh-icon" aria-hidden="true">↻</span>';
  currentButton.setAttribute("aria-label", "刷新");
  const failed = results.find((result) => result.status === "rejected");
  if (failed) alert(`刷新失败，${failed.reason.message}`);
}

function fastModeDescription(tier) {
  const multiplier = tier?.description?.match(/\b(\d+(?:\.\d+)?)\s*[x×]\s*speed\b/i)?.[1];
  return multiplier ? `当前模型标注约 ${multiplier} 倍生成速度，用量会增加。` : "更快生成回复，用量会增加。";
}

document.addEventListener("click", (event) => {
  if (!state.attachmentMenuOpen || event.target.closest(".composer-add-wrap")) return;
  state.attachmentMenuOpen = false;
  if (state.selected) renderWorkspace();
});

function confirmNearButton(selector, title, description, confirmLabel) {
  return new Promise((resolve) => {
    const anchor = $(selector);
    if (!anchor || $(".speed-confirm")) { resolve(false); return; }
    const popup = document.createElement("div");
    popup.className = "speed-confirm";
    popup.popover = "auto";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-labelledby", "speedConfirmTitle");
    popup.innerHTML = `<h3 id="speedConfirmTitle">${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p><div class="speed-confirm-actions"><button type="button" data-cancel>取消</button><button type="button" data-confirm>${escapeHTML(confirmLabel)}</button></div>`;
    let confirmed = false;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
      const top = rect.top >= popup.offsetHeight + 18 ? rect.top - popup.offsetHeight - 10 : rect.bottom + 10;
      popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - popup.offsetHeight - 8))}px`;
    };
    popup.addEventListener("toggle", (event) => {
      if (event.newState !== "closed") return;
      window.removeEventListener("resize", position);
      popup.remove();
      resolve(confirmed);
    });
    popup.querySelector("[data-cancel]").addEventListener("click", () => popup.hidePopover());
    popup.querySelector("[data-confirm]").addEventListener("click", () => { confirmed = true; popup.hidePopover(); });
    document.body.append(popup);
    popup.showPopover();
    position();
    window.addEventListener("resize", position);
  });
}

function formatTokens(value) {
  if (value == null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return String(number);
}

function usageStat(label, value) {
  return `<div class="usage-stat"><b>${value}</b><span>${escapeHTML(label)}</span></div>`;
}

function formatResetTime(resetsAt) {
  if (resetsAt == null) return "—";
  const timestamp = Number(resetsAt) * 1000;
  if (!Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  const hhmm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  const diff = timestamp - Date.now();
  if (diff <= 0) return `${monthDay} ${hhmm}`;
  const totalMinutes = Math.ceil(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const countdown = [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", `${minutes} 分钟`].filter(Boolean).join(" ");
  return `${countdown}后（${monthDay} ${hhmm}）`;
}

function windowDurationLabel(minutes) {
  if (minutes == null) return "";
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1440)} 天`;
}

function quotaBarClass(usedPercent) {
  if (usedPercent >= 100) return "is-full";
  if (usedPercent >= 80) return "is-high";
  return "";
}

function rateWindowHTML(title, fallbackLabel, window) {
  if (!window) return "";
  const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const duration = windowDurationLabel(window.windowDurationMins) || fallbackLabel;
  const reset = formatResetTime(window.resetsAt);
  return `<div class="quota-window"><div class="quota-window-head"><strong>${escapeHTML(title)}</strong><span class="quota-meta">${escapeHTML(duration)}${reset !== "—" ? ` · 重置 ${escapeHTML(reset)}` : ""}</span></div><div class="quota-bar"><span class="quota-bar-fill ${quotaBarClass(used)}" style="width:${used}%"></span></div><div class="quota-used">已用 ${used}%</div></div>`;
}

function rateLimitsHTML(limits) {
  const snapshot = limits?.rateLimits;
  if (!snapshot) return '<div class="usage-empty">暂无配额数据</div>';
  const allowed = limits.ordinaryUsageAllowed;
  const reached = allowed === false || snapshot.rateLimitReachedType === "rate_limit_reached";
  const status = allowed === null
    ? '<span class="quota-status unknown">额度状态未知</span>'
    : reached
      ? '<span class="quota-status blocked">已触达限流</span>'
      : '<span class="quota-status ok">额度正常</span>';
  const resets = limits.rateLimitResetCredits?.availableCount
    ? `<span class="quota-resets">剩余重置 ${limits.rateLimitResetCredits.availableCount} 次</span>`
    : "";
  const windows = [
    rateWindowHTML("本次额度", "短周期", snapshot.primary),
    rateWindowHTML("周期额度", "长周期", snapshot.secondary),
  ].filter(Boolean).join("");

  return `<div class="usage-section"><h3>配额状态</h3><div class="quota-status-row">${status}${resets}</div></div>${windows ? `<div class="usage-section"><h3>限流额度</h3><div class="quota-windows">${windows}</div></div>` : ""}`;
}

function usageHTML(usage) {
  const summary = usage.summary || {};
  const buckets = usage.dailyUsageBuckets || [];
  const recent = [...buckets].reverse().slice(0, 14);
  const maxDaily = recent.reduce((max, bucket) => Math.max(max, Number(bucket.tokens) || 0), 0);

  const stats = [
    usageStat("生命周期 tokens", formatTokens(summary.lifetimeTokens)),
    usageStat("单日峰值", formatTokens(summary.peakDailyTokens)),
    usageStat("连续使用天数", formatTokens(summary.currentStreakDays)),
    usageStat("最长连续天数", formatTokens(summary.longestStreakDays)),
  ].join("");

  const daily = recent.length
    ? `<div class="usage-daily">${recent.map((bucket) => {
      const tokens = Number(bucket.tokens) || 0;
      const width = maxDaily > 0 ? Math.max(2, Math.round((tokens / maxDaily) * 100)) : 0;
      return `<div class="usage-row"><span class="usage-date">${escapeHTML(bucket.startDate)}</span><span class="usage-bar-wrap"><span class="usage-bar" style="width:${width}%"></span></span><span class="usage-tokens">${formatTokens(tokens)}</span></div>`;
    }).join("")}</div>`
    : '<div class="usage-empty">暂无每日用量数据</div>';

  return `<div class="usage-section"><h3>账户概览</h3><div class="usage-stats">${stats}</div></div>
    <div class="usage-section"><h3>近 ${recent.length} 天用量</h3>${daily}</div>`;
}

const usageRefreshIntervalMs = 5 * 60 * 1000;
let accountLimits = null;
let accountUsage = null;
let usageRequestFailures = [];
let usageRefreshPending = false;

function quotaResetCountdown(resetsAt) {
  if (!Number.isFinite(resetsAt)) return "";
  const reset = new Date(resetsAt * 1000);
  const minutesLeft = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 60000));
  const days = Math.floor(minutesLeft / 1440);
  const hours = Math.floor(minutesLeft / 60) % 24;
  const minutes = minutesLeft % 60;
  const countdown = [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(" ");
  const resetTime = reset.toLocaleString([], {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `<time class="sidebar-usage-reset" datetime="${reset.toISOString()}" title="重置时间 ${escapeHTML(resetTime)}"><span aria-hidden="true">◷</span> ${countdown}</time>`;
}

function quotaHighlight(window, exhaustedLabel = "0%") {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const level = remaining <= 10 ? "low" : remaining <= 30 ? "warning" : "healthy";
  return `<b class="quota-highlight ${level}">${remaining === 0 ? exhaustedLabel : `${remaining}%`}</b>`;
}

function renderSidebarQuota() {
  const snapshot = accountLimits?.rateLimits;
  const primary = snapshot?.primary;
  const secondary = snapshot?.secondary;
  const shortLabel = windowDurationLabel(primary?.windowDurationMins) || "短周期";
  const resets = accountLimits?.rateLimitResetCredits?.availableCount;
  $("#sidebarUsageData").innerHTML = [
    primary ? `<div class="sidebar-usage-row"><span class="sidebar-usage-value">${escapeHTML(shortLabel)}${primary.usedPercent < 100 ? "剩 " : " "}${quotaHighlight(primary, "用完")}</span>${quotaResetCountdown(primary.resetsAt)}</div>` : "",
    secondary || resets != null ? `<div class="sidebar-usage-row"><span class="sidebar-usage-value">${secondary ? `额度 ${quotaHighlight(secondary)}` : ""}${resets != null ? `${secondary ? " · " : ""}重置 <b>${resets}</b> 次` : ""}</span>${quotaResetCountdown(secondary?.resetsAt)}</div>` : "",
  ].join("");
}

const usageLimitMessage = "已达到用量上限";
const sendUsageLimits = new Set();

function renderConversationUsageNotice() {
  const notice = $("#conversationUsageNotice");
  if (!notice) return;
  const task = state.selected;
  const snapshot = accountLimits?.rateLimits;
  const accountBlocked = accountLimits?.ordinaryUsageAllowed === false ||
    snapshot?.rateLimitReachedType === "rate_limit_reached" ||
    [snapshot?.primary, snapshot?.secondary].some(window => window?.usedPercent >= 100);
  const lastError = task?.events?.findLast(event => event.kind === "error");
  const turnBlocked = task?.status === "codex_error" && lastError?.message === usageLimitMessage;
  notice.hidden = !(accountBlocked || turnBlocked || sendUsageLimits.has(task?.id));
}

function renderAccountUsage() {
  renderSidebarQuota();
  renderConversationUsageNotice();
  $("#sidebarUsageStatus").textContent = usageRefreshPending
    ? ""
    : usageRequestFailures.includes("配额")
      ? "配额刷新失败"
      : $("#sidebarUsageData").children.length ? "" : "暂无用量数据";

  if (!$("#usageDialog").open) return;
  $("#usageBody").innerHTML = `${usageRequestFailures.length ? `<div class="usage-error">${escapeHTML(usageRequestFailures.join("和"))}刷新失败</div>` : ""}${accountLimits ? rateLimitsHTML(accountLimits) : ""}${accountUsage ? usageHTML(accountUsage) : ""}`;
}

async function refreshAccountUsage() {
  if (usageRefreshPending) return;
  usageRefreshPending = true;
  usageRequestFailures = [];
  $("#refreshUsage").disabled = true;
  renderAccountUsage();

  try {
    const [limits, usage] = await Promise.allSettled([
      api("/api/codex/rate-limits"),
      api("/api/codex/usage"),
    ]);
    if (limits.status === "fulfilled") {
      accountLimits = limits.value;
      if (accountLimits?.ordinaryUsageAllowed === true) sendUsageLimits.clear();
    } else usageRequestFailures.push("配额");
    if (usage.status === "fulfilled") accountUsage = usage.value;
    else usageRequestFailures.push("用量");
  } finally {
    usageRefreshPending = false;
    $("#refreshUsage").disabled = false;
    renderAccountUsage();
  }
}

function openUsageDialog() {
  $("#usageDialog").showModal();
  renderAccountUsage();
}

function renderWorkspace() {
  const task = state.selected;
  if (!task) return;
  const selectedCodexMode = selectedWorkMode(task);
  const inPlan = displayPhase(task.phase) === "plan";
  const canChooseMode = (inPlan || task.phase === "development") && !isArchived(task);
  const defaultModeLabel = inPlan ? "默认问答" : "默认";
  const modeControl = canChooseMode
    ? `<button type="button" id="codexWorkMode" class="codex-mode-badge ${selectedCodexMode}" title="切换至${selectedCodexMode === "plan" ? defaultModeLabel : " Plan"}"><span class="mode-indicator" aria-hidden="true"></span>Codex · ${selectedCodexMode === "plan" ? "Plan" : defaultModeLabel}</button>`
    : '<span class="codex-mode-badge default"><span class="mode-indicator"></span>Codex · 默认</span>';
  const previousResults = $(".task-results");
  const resultsOpen = previousResults?.dataset.phase === task.phase ? previousResults.open : undefined;
  const detailsOpen = $(".workspace-details")?.classList.contains("is-open");
  const sidebarScrollTop = $(".workspace-details")?.scrollTop || 0;
  const previousList = $(".conversation-list");
  const conversationTop = previousList && previousList.scrollHeight - previousList.clientHeight - previousList.scrollTop >= 16
    ? previousList.scrollTop : null;
  const currentIndex = phases.indexOf(displayPhase(task.phase));
  const phaseSteps = phases.map((phase, index) => `<div class="phase-step ${index < currentIndex ? "done" : index === currentIndex ? "active" : ""}">
    <span class="num">${index < currentIndex ? "✓" : index + 1}</span>${phaseLabels[phase]}
  </div>${index < phases.length - 1 ? '<div class="phase-line"></div>' : ""}`).join("");

  const blocker = task.status === "release_failed"
    ? `<div class="error-banner">发布步骤已暂停：${escapeHTML(task.result?.releaseSteps?.find((step) => step.status === "failed")?.error || "请检查发布配置" )}</div>`
    : task.status === "persistence_error"
      ? '<div class="error-banner">任务状态未能可靠保存。请检查 MySQL 后重新加载任务。</div>' : "";
  const archivedNotice = isArchived(task)
    ? '<div class="archive-notice">任务已归档。Codex 会话没有停止；恢复任务后可以继续操作。</div>' : "";
  const canConfigureCodex = !isArchived(task) && ["plan", "development", "dev_review"].includes(displayPhase(task.phase)) &&
    !["persistence_error", "release_failed"].includes(task.status) &&
    (task.status !== "needs_review" || task.phase === "development");
  const gated = !canConfigureCodex || (inPlan && Boolean(task.approval) && selectedCodexMode === "plan" && !deferredPlanApproval(task));
  const events = (task.events || []).map((event) => `<div class="event"><span class="event-icon">${event.kind === "error" ? "!" : "·"}</span>
    <div><p>${escapeHTML(event.message)}</p><time>${Number.isFinite(new Date(event.createdAt).getTime()) ? new Date(event.createdAt).toLocaleString() : "时间未知"}</time></div></div>`).join("");
  const latestEvent = (task.events || []).reduce((latest, event) => {
    const timestamp = new Date(event.createdAt).getTime();
    return Number.isFinite(timestamp) && (!latest || timestamp > latest.timestamp) ? { timestamp, createdAt: event.createdAt } : latest;
  }, null);
  const latestEventTime = latestEvent ? new Date(latestEvent.createdAt).toLocaleString() : "暂无事件";
  const model = selectedCodexModel();
  const fastTier = fastServiceTier(model);
  const fastActive = Boolean(fastTier) && state.speedMode === "priority";
  const modelPicker = modelPickerHTML(model, !canConfigureCodex || state.codexModelsLoading || !state.codexModels.length);
  const result = `<details class="workspace-panel task-results" data-phase="${escapeHTML(task.phase)}"><summary class="panel-title">任务结果与审核</summary><div class="panel-body result-summary">
    ${task.result?.summary ? `<div class="result-plan"><strong>方案</strong><div class="conversation-text">${renderMarkdown(task.result.summary)}</div></div>` : ""}
    ${task.result?.developmentSummary ? `<p><strong>开发总结：</strong>${escapeHTML(task.result.developmentSummary)}</p>` : ""}
    ${task.result?.reviewSummary ? `<p><strong>Review：</strong>${escapeHTML(task.result.reviewSummary)}</p>` : ""}
    ${task.phase === "dev_review" && !isArchived(task) ? '<button class="button primary" data-approval="accept">验收并启动 Code Review</button>' : ""}
    ${(task.result?.changes || []).length ? `<div><strong>改动</strong><ul>${task.result.changes.map((item) => `<li>${escapeHTML(item.file)}：${escapeHTML(item.summary)}</li>`).join("")}</ul></div>` : ""}
    ${(task.result?.checks || []).length ? `<div><strong>检查结果</strong><ul>${task.result.checks.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul></div>` : ""}
    ${(task.result?.risks || []).length ? `<div><strong>风险与处置</strong>${task.result.risks.map((risk) => `<article class="risk-card"><b>${escapeHTML(risk.title)} · ${escapeHTML(risk.category)}</b><p>${escapeHTML(risk.location)}：${escapeHTML(risk.impact)}</p><p>建议：${escapeHTML(risk.suggestion)} · 状态：${escapeHTML(risk.status || "pending")}</p>${task.phase === "risk_review" && !isArchived(task) && risk.status !== "accepted" && risk.status !== "fixed" ? `<textarea id="riskComment-${escapeHTML(risk.id)}" rows="2" placeholder="整改意见（整改时必填）">${escapeHTML(state.riskDrafts[risk.id] || "")}</textarea><div class="modal-actions"><button class="button" data-risk-action="fix" data-risk-id="${escapeHTML(risk.id)}">整改</button><button class="button" data-risk-action="accept" data-risk-id="${escapeHTML(risk.id)}">接受风险</button></div>` : ""}</article>`).join("")}</div>` : ""}
    ${task.phase === "risk_review" && !isArchived(task) ? '<button class="button primary" data-approval="confirm">确认风险并开始发布</button>' : ""}
    ${task.phase === "release" && (task.result?.releaseSteps || []).length ? `<div><strong>发布步骤</strong><ul>${task.result.releaseSteps.map((step) => `<li>${escapeHTML(step.name)}：${escapeHTML(step.status)}${step.error ? `（${escapeHTML(step.error)}）` : ""}</li>`).join("")}</ul></div>` : ""}
    ${task.phase === "release" && task.status === "release_failed" && !isArchived(task) ? '<button class="button primary" data-approval="retry">重试失败步骤</button>' : ""}
    ${task.result?.report ? `<details><summary>完整执行报告</summary><pre>${escapeHTML(JSON.stringify(task.result.report, null, 2))}</pre></details>` : ""}
  </div></details>`;
  const resultVisible = currentIndex >= phases.indexOf("development");

  $("#workspace").innerHTML = `<div class="workspace-head"><div class="workspace-heading"><h2>${escapeHTML(task.title)}</h2><p>${escapeHTML(task.repositoryPath)}</p></div><div class="workspace-actions"><button type="button" class="button" id="releaseSessionLock" title="关闭当前任务的 Codex 会话并释放写入锁" ${!task.codexThreadId || task.codexActive || isCodexActive() ? "disabled" : ""}>释放会话写入锁</button><button type="button" class="button refresh-workspace-button" id="refreshWorkspace" aria-label="${state.refreshingTaskID === task.id ? "刷新中" : "刷新"}" title="${state.refreshingTaskID === task.id ? "刷新中" : "刷新"}" ${state.refreshingTaskID === task.id ? "disabled" : ""}><span class="refresh-icon ${state.refreshingTaskID === task.id ? "is-spinning" : ""}" aria-hidden="true">↻</span></button><button type="button" class="button" id="toggleWorkspaceDetails" aria-expanded="false" aria-controls="workspaceDetails">运行事件</button><button class="button ${isArchived(task) ? "" : "archive-button"}" id="toggleArchive">${isArchived(task) ? "恢复任务" : "归档任务"}</button></div></div><div class="phasebar">${phaseSteps}</div>${archivedNotice}
    <div class="workspace-grid"><div><div id="approvalSlot">${blocker}</div>${resultVisible ? result : ""}
      <section class="workspace-panel conversation-panel"><div class="panel-title">Codex 会话</div><div id="conversationUsageNotice" class="conversation-usage-notice" role="status" hidden>${usageLimitMessage}</div><div class="panel-body conversation-list">
        ${state.conversationError ? `<div class="form-error">无法从 Codex 读取会话：${escapeHTML(state.conversationError)}</div>` : '<div class="task-sub">会话中暂无消息</div>'}
      </div></section>
      <div class="composer"><div class="attachment-list">${state.attachments.map((image, index) => `<span class="attachment-chip"><img src="${image.dataURL}" alt="${escapeHTML(image.name)}"><button type="button" data-remove-attachment="${index}" aria-label="移除图片">×</button></span>`).join("")}</div><textarea id="messageInput" required placeholder="${isArchived(task) ? "请先恢复任务再继续会话" : task.phase === "development" ? "Codex 执行中，可发送补充要求或引导…" : "继续向 Codex 提交任务指令…"}" ${gated ? "disabled" : ""}>${escapeHTML(state.draft)}</textarea>
      <div class="composer-settings"><div class="composer-add-wrap"><button type="button" class="composer-plus" id="toggleAttachmentMenu" aria-label="更多选项" ${gated ? "disabled" : ""}>＋</button>${state.attachmentMenuOpen ? '<div class="attachment-menu"><button type="button" id="chooseImage">选择图片</button></div>' : ""}</div><input id="fileInput" type="file" accept="image/*" multiple hidden><span class="composer-option" title="Codex 拥有本机进程权限，工具执行无需审批">完全访问</span>${modeControl}<span class="composer-separator"></span>${modelPicker}<button type="button" id="toggleSpeed" class="speed-button ${fastActive ? "active" : ""}" aria-pressed="${fastActive}" title="${fastTier ? `${fastModeDescription(fastTier)}下一轮生效。` : "当前模型不支持快速模式"}" ${!canConfigureCodex || state.codexModelsLoading || !fastTier ? "disabled" : ""}><span aria-hidden="true">${fastActive ? "⚡" : "◷"}</span><span>${fastActive ? "快速" : "普通"}</span></button><button class="button primary" id="sendMessage" aria-label="发送消息" ${gated ? "disabled" : ""}>↑</button></div></div>
    </div><aside class="workspace-details" id="workspaceDetails"><section class="workspace-panel event-side-card"><div class="panel-title event-panel-title"><span>运行事件</span><time>${escapeHTML(latestEventTime)}</time></div><div class="panel-body timeline event-scrollbox">${events || '<div class="task-sub">暂无运行事件</div>'}</div></section></aside></div>`;

  renderConversationUsageNotice();
  const workspace = $("#workspace");
  const composer = workspace.querySelector(".composer");
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "composer-resize-handle";
  resizeHandle.tabIndex = 0;
  resizeHandle.setAttribute("role", "separator");
  resizeHandle.setAttribute("aria-orientation", "horizontal");
  resizeHandle.setAttribute("aria-label", "拖动调整输入框高度，向上增大");
  resizeHandle.title = "向上拖动可展开输入框";
  composer.prepend(resizeHandle);
  const messageInput = composer.querySelector("#messageInput");
  if (state.composerInputHeight) messageInput.style.height = `${state.composerInputHeight}px`;
  const resizeInput = (height) => {
    const maxHeight = Math.max(42, Math.min(window.innerHeight * 0.45, workspace.clientHeight - 160));
    state.composerInputHeight = Math.round(Math.max(42, Math.min(maxHeight, height)));
    messageInput.style.height = `${state.composerInputHeight}px`;
    resizeHandle.setAttribute("aria-valuenow", String(state.composerInputHeight));
  };
  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = messageInput.getBoundingClientRect().height;
    resizeHandle.setPointerCapture(event.pointerId);
    composer.classList.add("resizing");
    const move = (event) => resizeInput(startHeight + startY - event.clientY);
    const finish = () => {
      composer.classList.remove("resizing");
      resizeHandle.removeEventListener("pointermove", move);
      resizeHandle.removeEventListener("lostpointercapture", finish);
    };
    resizeHandle.addEventListener("pointermove", move);
    resizeHandle.addEventListener("lostpointercapture", finish);
  });
  resizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resizeInput(messageInput.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24));
  });
  const center = document.createElement("div");
  center.className = "workspace-center";
  const grid = workspace.querySelector(".workspace-grid");
  const taskResults = grid.querySelector(".task-results");
  if (taskResults) taskResults.open = resultsOpen ?? ["dev_review", "risk_review", "release"].includes(task.phase);
  const details = grid.querySelector(".workspace-details");
  const header = document.createElement("div");
  header.className = "workspace-header";
  composer.remove();
  center.append(...grid.firstElementChild.childNodes);
  grid.remove();
  header.append(...workspace.childNodes);
  workspace.append(header, center, composer, details);
  gitExplorer.setTask(task);
  const detailsButton = $("#toggleWorkspaceDetails");
  const setDetailsOpen = (open) => {
    details.classList.toggle("is-open", open);
    detailsButton.setAttribute("aria-expanded", String(open));
    detailsButton.textContent = open ? "关闭运行事件" : "运行事件";
  };
  setDetailsOpen(Boolean(detailsOpen));
  details.scrollTop = sidebarScrollTop;
  detailsButton.addEventListener("click", () => setDetailsOpen(!details.classList.contains("is-open")));

  $("#codexWorkMode")?.addEventListener("click", () => {
    if (selectedCodexMode === "plan" && task.approval?.id) {
      localStorage.setItem(`workflow.deferredPlanApproval.${task.id}`, task.approval.id);
    }
    localStorage.setItem(workModeKey(task), selectedCodexMode === "plan" ? "default" : "plan");
    renderWorkspace();
    $("#codexWorkMode")?.focus();
  });
  $("#sendMessage").dataset.gated = String(gated);
  $("#messageInput").dataset.phaseGated = String(gated);
  renderConversation(false, conversationTop);
  $("#toggleSpeed")?.addEventListener("click", async () => {
    const taskID = state.selected?.id;
    const nextMode = state.speedMode === "priority" ? "default" : "priority";
    if (nextMode === "priority" && !await confirmNearButton("#toggleSpeed", "开启快速模式？", fastModeDescription(fastTier), "开启快速")) return;
    if (state.selected?.id !== taskID || selectedCodexModel() !== model) return;
    state.speedMode = nextMode;
    localStorage.setItem("workflow.speedMode", nextMode);
    const button = $("#toggleSpeed");
    if (!button) return;
    const active = nextMode === "priority";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `<span aria-hidden="true">${active ? "⚡" : "◷"}</span><span>${active ? "快速" : "普通"}</span>`;
  });
  $("#sendMessage")?.addEventListener("click", () => isCodexActive() ? stopCodex() : sendMessage());
  $("#toggleAttachmentMenu")?.addEventListener("click", () => { state.attachmentMenuOpen = !state.attachmentMenuOpen; renderWorkspace(); });
  $("#chooseImage")?.addEventListener("click", () => { state.attachmentMenuOpen = false; $("#fileInput")?.click(); });
  $("#fileInput")?.addEventListener("change", (event) => {
    [...event.target.files].forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => { state.attachments.push({ name: file.name, dataURL: reader.result }); renderWorkspace(); };
      reader.readAsDataURL(file);
    });
  });
  $("#workspace").querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => { state.attachments.splice(Number(button.dataset.removeAttachment), 1); renderWorkspace(); }));
  $("#toggleModelMenu")?.addEventListener("click", () => setModelMenuOpen(!state.modelMenuOpen));
  $("#modelPickerMenu")?.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedModel = button.dataset.model;
      localStorage.setItem("workflow.codexModel", state.selectedModel);
      renderWorkspace();
      const slider = $("#modelReasoningEffort");
      (slider && !slider.disabled ? slider : $("#toggleModelMenu"))?.focus();
    });
  });
  bindModelEffortSlider(model);
  positionModelMenu();
  $("#messageInput")?.addEventListener("input", (event) => { state.draft = event.target.value; event.target.setCustomValidity(""); });
  $("#messageInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#workspace").querySelectorAll("[id^='riskComment-']").forEach((textarea) => textarea.addEventListener("input", () => { state.riskDrafts[textarea.id.slice("riskComment-".length)] = textarea.value; }));
  $("#workspace").querySelectorAll("[data-approval]").forEach((button) => button.addEventListener("click", () => sendApproval(button.dataset.approval)));
  $("#workspace").querySelectorAll("[data-risk-action]").forEach((button) => button.addEventListener("click", () => sendRiskAction(button.dataset.riskAction, button.dataset.riskId)));
  $("#releaseSessionLock")?.addEventListener("click", async () => {
    const button = $("#releaseSessionLock");
    if (!button || button.disabled || !state.selected?.id) return;
    button.disabled = true;
    try {
      await api(`/api/tasks/${state.selected.id}/release-session-lock`, {method:"POST"});
      await refreshSelectedTask(state.selected.id);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });
  $("#refreshWorkspace").addEventListener("click", refreshWorkspace);
  $("#toggleArchive").addEventListener("click", toggleArchive);
}

async function sendMessage() {
  if (state.codexRestarting) return;
  const input = $("#messageInput");
  if (input.disabled) return;
  const text = input.value.trim();
  const files = state.attachments;
  const message = text;
  if (!message) {
    input.setCustomValidity("请输入消息内容后再发送");
    input.reportValidity();
    input.focus();
    return;
  }
  input.setCustomValidity("");
  const task = state.selected;
  const taskID = task.id;
  const mode = selectedWorkMode(task);
  const approvalID = mode === "plan" && displayPhase(task.phase) === "plan" ? deferredPlanApproval(task) : "";
  const wasActive = isCodexActive();
  sendUsageLimits.delete(taskID);
  renderConversationUsageNotice();
  state.sendingMessage = true;
  const optimisticMessage = appendUserMessage(message);
  updateSendButton();
  state.draft = "";
  state.attachments = [];
  $("#messageInput").value = "";
  try {
    if (approvalID) {
      await api(`/api/tasks/${taskID}/approvals`, {
        method: "POST",
        body: JSON.stringify({ action: "request_changes", comment: message, approvalId: approvalID, ...turnPreferences() }),
      });
      if (state.selected?.id === taskID) state.approvalDraft = "";
    } else {
      await api(`/api/tasks/${taskID}/messages`, { method: "POST", body: JSON.stringify({ message, mode, ...turnPreferences() }) });
    }
    if (wasActive) {
      state.sendingMessage = false;
      renderConversation();
    } else {
      window.setTimeout(() => {
        if (state.selected?.id === taskID && state.sendingMessage && !isCodexActive()) {
          state.sendingMessage = false;
          renderConversation();
        }
      }, 30000);
    }
    await refreshSelectedTask(taskID);
  } catch (error) {
    state.sendingMessage = false;
    removeConversationMessage(optimisticMessage);
    state.draft = message;
    const input = $("#messageInput");
    if (input) input.value = message;
    if (/usage limit|usage_limit_reached/i.test(error.message)) {
      sendUsageLimits.add(taskID);
      renderConversationUsageNotice();
    } else {
      alert(error.message);
    }
  }
}

async function submitUserInput(event) {
  event.preventDefault();
  const request = state.pendingUserInput;
  const taskID = state.selected?.id;
  const form = event.currentTarget;
  if (!request || !taskID || state.answeringUserInput) return;
  const answers = {};
  for (const [index, question] of (request.questions || []).entries()) {
    const selected = form.querySelector(`input[name="answer-${index}"]:checked`)?.value;
    if ((question.options || []).length === 0 && !question.isOther) {
      const text = form.querySelector(`[data-free-answer="${index}"]`)?.value.trim() || "";
      if (!text) return showUserInputError(form, `请回答：${question.question}`);
      answers[question.id] = [`user_note: ${text}`];
    } else if (selected === "__other__") {
      const text = form.querySelector(`[data-other-answer="${index}"]`)?.value.trim() || "";
      if (!text) return showUserInputError(form, "请填写自定义答案");
      answers[question.id] = [`user_note: ${text}`];
    } else if (selected) {
      answers[question.id] = [selected];
    } else {
      return showUserInputError(form, `请选择：${question.question}`);
    }
  }
  state.answeringUserInput = true;
  form.querySelectorAll("input, textarea, button").forEach((element) => { element.disabled = true; });
  form.querySelector("[role=alert]").textContent = "";
  try {
    await api(`/api/tasks/${taskID}/user-input`, {
      method: "POST",
      body: JSON.stringify({ requestId: request.requestId, answers }),
    });
  } catch (error) {
    if (state.selected?.id !== taskID || state.pendingUserInput?.requestId !== request.requestId) return;
    state.answeringUserInput = false;
    form.querySelectorAll("input, textarea, button").forEach((element) => { element.disabled = false; });
    showUserInputError(form, error.message);
  }
}

function showUserInputError(form, message) {
  const error = form.querySelector("[role=alert]");
  if (error) error.textContent = message;
}

function approvalMessage(action, comment) {
  switch (action) {
    case "approve":
      return "我已通过开发方案。";
    case "request_changes":
      return comment ? `修改意见：\n${comment}` : "我要求修改开发方案。";
    case "accept":
      return "我已验收开发结果，开始 Code Review。";
    case "confirm":
      return "我已确认风险处理完成，开始发布。";
    case "retry":
      return "我已发起发布重试。";
    default:
      return "我已提交审批操作。";
  }
}

async function sendApproval(action) {
  const taskID = state.selected.id;
  if (state.submittingApproval === taskID) return;
  const field = $("#approvalComment");
  const comment = field?.value.trim() || "";
  if (action === "request_changes" && !comment) {
    field?.setCustomValidity("请填写方案修改意见");
    field?.reportValidity();
    return;
  }
  const planReply = recoverablePlanReply(state.selected);
  state.submittingApproval = taskID;
  const optimisticMessage = appendUserMessage(approvalMessage(action, comment));
  try {
    await api(`/api/tasks/${taskID}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        action,
        comment,
        planReply,
        ...(["approve", "request_changes", "accept"].includes(action) ? turnPreferences() : {}),
      }),
    });
    if (state.selected?.id === taskID) state.approvalDraft = "";
    await refreshSelectedTask(taskID);
  } catch (error) {
    if (state.selected?.id === taskID) {
      removeConversationMessage(optimisticMessage);
      if (action === "approve") await refreshSelectedTask(taskID);
    }
    alert(error.message);
  } finally {
    if (state.submittingApproval === taskID) state.submittingApproval = null;
    if (state.selected?.id === taskID) renderConversation();
  }
}

async function sendRiskAction(action, riskId) {
  const taskID = state.selected.id;
  const comment = $(`#riskComment-${CSS.escape(riskId)}`)?.value.trim() || "";
  const risk = (state.selected.result?.risks || []).find((item) => item.id === riskId);
  const optimisticText = action === "fix"
    ? `整改意见：\n${comment}`
    : `我已接受风险：${risk?.title || riskId}`;
  const optimisticMessage = appendUserMessage(optimisticText);
  try {
    await api(`/api/tasks/${taskID}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        action,
        riskId,
        comment,
      }),
    });
    delete state.riskDrafts[riskId];
    await refreshSelectedTask(taskID);
  } catch (error) {
    removeConversationMessage(optimisticMessage);
    alert(error.message);
  }
}

async function toggleArchive() {
  const task = state.selected;
  if (!task) return;
  const restoring = isArchived(task);
  if (!restoring) {
    const confirmed = await confirmNearButton("#toggleArchive", "归档这个任务？", "归档后可在已归档列表中恢复，Codex 会话不会停止。", "确认归档");
    if (!confirmed || state.selected?.id !== task.id) return;
  }
  try {
    await api(`/api/tasks/${task.id}/archive`, {
      method: restoring ? "DELETE" : "POST",
    });
    if (restoring) {
      await openTask(task.id);
      return;
    }
    state.filter = "all";
    document.querySelectorAll(".filter").forEach((item) => {
      item.classList.toggle("active", item.dataset.filter === "all");
    });
    $("#backToTasks").click();
  } catch (error) {
    alert(error.message);
  }
}

let directoryListing = null;
let directoryRequest = 0;
async function loadDirectory(path = "") {
  const request = ++directoryRequest;
  const list = $("#directoryList");
  const error = $("#directoryError");
  list.innerHTML = '<div class="directory-list-empty">正在读取目录…</div>';
  error.classList.add("hidden");
  try {
    const result = await api(`/api/directories?path=${encodeURIComponent(path)}`);
    if (request !== directoryRequest) return;
    directoryListing = result;
    $("#directoryCurrent").textContent = result.current;
    $("#directoryUp").disabled = !result.parent;
    list.innerHTML = result.entries.length ? result.entries.map((entry, index) => `<div class="directory-entry"><button type="button" class="directory-entry-name" data-enter-directory="${index}" title="${escapeHTML(entry.path)}">📁 ${escapeHTML(entry.name)}</button><button type="button" class="directory-entry-select" data-select-directory="${index}">选择</button></div>`).join("") : '<div class="directory-list-empty">此目录下没有子目录</div>';
  } catch (failure) {
    if (request !== directoryRequest) return;
    directoryListing = null;
    list.innerHTML = "";
    error.textContent = failure.message;
    error.classList.remove("hidden");
  }
}

function chooseDirectory(path) {
  $("#createForm [name=repositoryPath]").value = path;
  $("#directoryDialog").close();
  $("#createForm [name=repositoryPath]").focus();
}

$("#chooseDirectory").addEventListener("click", () => {
  $("#directoryDialog").showModal();
  void loadDirectory();
});
$("#directoryUp").addEventListener("click", () => {
  if (directoryListing?.parent) void loadDirectory(directoryListing.parent);
});
$("#selectDirectory").addEventListener("click", () => {
  if (directoryListing?.current) chooseDirectory(directoryListing.current);
});
$("#directoryList").addEventListener("click", (event) => {
  const enter = event.target.closest("[data-enter-directory]");
  const select = event.target.closest("[data-select-directory]");
  const index = Number(enter?.dataset.enterDirectory ?? select?.dataset.selectDirectory);
  const entry = directoryListing?.entries[index];
  if (!entry) return;
  if (select) chooseDirectory(entry.path);
  else void loadDirectory(entry.path);
});
$("#closeDirectoryDialog").addEventListener("click", () => $("#directoryDialog").close());
$("#cancelDirectory").addEventListener("click", () => $("#directoryDialog").close());
$("#directoryDialog").addEventListener("click", (event) => { if (event.target === $("#directoryDialog")) $("#directoryDialog").close(); });

$("#newTask").addEventListener("click", () => $("#createDialog").showModal());
$("#cancelCreate").addEventListener("click", () => $("#createDialog").close());
$("#emptyNew").addEventListener("click", () => {
  $("#createDialog").showModal();
});
$("#backToTasks").addEventListener("click", () => {
  stopConversationStream();
  setModelMenuOpen(false);
  document.body.classList.remove("workspace-active");
  gitExplorer.setTask(null);
  $("#workspacePage").classList.add("hidden"); $("#listPage").classList.remove("hidden");
  $("#pageTitle").textContent = "开发工作流"; state.selected = null; state.draft = ""; state.approvalDraft = ""; refreshTasks();
});
$("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]"); if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  renderRows();
});

$("#createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  const button = $("#createSubmit"), errorBox = $("#formError");
  button.disabled = true; button.textContent = "正在创建…"; errorBox.classList.add("hidden");
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(data) });
    $("#createDialog").close(); form.reset();
    stopConversationStream();
    state.selected = task;
    state.conversation = [{
      role: "user",
      text: initialTaskMessage(data),
    }];
    state.conversationError = "";
    showTaskWorkspace();
    renderWorkspace();
    startConversationStream(task.id);
    refreshTasks();
  } catch (error) { errorBox.textContent = error.message; errorBox.classList.remove("hidden"); }
  finally { button.disabled = false; button.textContent = "创建并开始分析"; }
});

$("#createDialog").addEventListener("click", (event) => { if (event.target === $("#createDialog")) $("#createDialog").close(); });
$("#openUsage").addEventListener("click", openUsageDialog);
$("#refreshUsage").addEventListener("click", refreshAccountUsage);
refreshAccountUsage();
window.setInterval(refreshAccountUsage, usageRefreshIntervalMs);
window.setInterval(() => {
  if ($("#usageDialog").open) renderAccountUsage();
  else renderSidebarQuota();
}, 60 * 1000);
$("#closeUsageDialog").addEventListener("click", () => $("#usageDialog").close());
$("#usageDialog").addEventListener("click", (event) => { if (event.target === $("#usageDialog")) $("#usageDialog").close(); });
refreshTasks();
refreshStatus();

