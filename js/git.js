const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

export function createGitExplorer({ api, confirm }) {
  const host = document.querySelector("#gitExplorer");
  const toggle = document.querySelector("#toggleGitExplorer");
  const dialog = document.createElement("dialog");
  dialog.className = "git-diff-dialog";
  dialog.setAttribute("aria-label", "文件改动");
  document.body.append(dialog);
  let task = null, repositories = [], selected = "", info = null;
  let loading = false, busy = false, error = "", notice = "", limited = false;
  let revision = 0, statusRequest = 0, diffRequest = 0;
  let diffData = null, diffTab = "unstaged";
  const route = (suffix = "") => `/api/tasks/${encodeURIComponent(task.id)}/git${suffix}`;
  const query = () => new URLSearchParams({ repository: selected });
  const blocked = () => busy || task?.codexActive || task?.status === "archived" || Boolean(task?.archivedAt);

  toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("git-drawer-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#gitExplorer, #toggleGitExplorer, .git-diff-dialog, .speed-confirm")) {
      document.body.classList.remove("git-drawer-open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

  function render() {
    if (!task) { host.classList.add("hidden"); toggle.classList.add("hidden"); return; }
    host.classList.remove("hidden"); toggle.classList.remove("hidden");
    const repoOptions = repositories.map((repo) => `<option value="${escapeHTML(repo.path)}" ${repo.path === selected ? "selected" : ""}>${escapeHTML(repo.path === "." ? repo.name : repo.path)}</option>`).join("");
    host.innerHTML = `<div class="git-explorer-heading"><h2>源代码管理</h2><button type="button" data-scan title="重新扫描仓库" aria-label="重新扫描仓库" ${busy || loading ? "disabled" : ""}>↻</button></div>
      ${error ? `<div class="git-error" role="alert">${escapeHTML(error)}</div>` : ""}
      ${notice ? `<div class="git-notice" role="status">${escapeHTML(notice)}</div>` : ""}
      ${loading ? '<div class="git-empty" role="status">正在扫描 Git 仓库…</div>' : ""}
      ${!loading && !repositories.length ? '<div class="git-empty">当前任务目录未发现 Git 仓库。<br>点击刷新可重新扫描。</div>' : ""}
      ${repositories.length ? `<label class="git-control-label" for="gitRepository">仓库 · ${repositories.length}</label><select id="gitRepository" ${busy || loading ? "disabled" : ""}>${repoOptions}</select>` : ""}
      ${limited ? '<div class="git-hint">仅扫描前 4 层，最多 32 个仓库；已跳过依赖与构建目录。扫描结果可能不完整。</div>' : ""}
      ${info && !loading ? repositoryHTML() : repositories.length && !loading && !error ? '<div class="git-empty">正在读取仓库状态…</div>' : ""}`;
    host.querySelector("[data-scan]").onclick = () => scan();
    host.querySelector("#gitRepository")?.addEventListener("change", (event) => {
      selected = event.target.value; info = null; error = ""; notice = "";
      sessionStorage.setItem(`workflow.gitRepository.${task.id}`, selected);
      render(); void refresh();
    });
    host.querySelector("#gitBranch")?.addEventListener("change", async (event) => {
      const value = event.target.value;
      if (!value) return;
      const separator = value.indexOf(":");
      const kind = value.slice(0, separator), name = value.slice(separator + 1);
      if (kind === "local" && name === info?.branch) { render(); return; }
      const version = revision, repository = selected;
      const approved = await confirm("#gitBranch", "切换分支？", `切换到 ${name}。工作区有未提交改动时会停止操作。`, "切换分支");
      if (version !== revision || repository !== selected) return;
      if (approved) void operate(kind === "remote" ? "track" : "checkout", name);
      else render();
    });
    host.querySelector("[data-fetch]")?.addEventListener("click", () => operate("fetch"));
    host.querySelector("[data-pull]")?.addEventListener("click", async () => {
      const version = revision, repository = selected;
      const approved = await confirm("[data-pull]", "拉取当前分支？", "从上游拉取更新，仅允许快进，不会自动创建合并提交。", "拉取更新");
      if (approved && version === revision && repository === selected) void operate("pull");
    });
    host.querySelector("[data-push]")?.addEventListener("click", async () => {
      const version = revision, repository = selected;
      const approved = await confirm("[data-push]", "推送本地提交？", `将当前分支领先上游的 ${info.ahead} 个提交推送到 ${info.upstream}。`, "推送提交");
      if (approved && version === revision && repository === selected) void operate("push");
    });
    host.querySelector("[data-create]")?.addEventListener("click", () => {
      const form = host.querySelector(".git-create-form");
      form.classList.toggle("hidden");
      if (!form.classList.contains("hidden")) form.querySelector("input").focus({ preventScroll: true });
    });
    host.querySelector(".git-create-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = event.currentTarget.elements.branch.value.trim();
      if (name) void operate("create", name);
    });
    host.querySelectorAll("[data-file]").forEach((button) => {
      button.addEventListener("click", () => openDiff(info.files[Number(button.dataset.file)]));
    });
  }

  function repositoryHTML() {
    const branch = info.detached ? `分离 HEAD · ${info.branch}` : info.branch;
    const branches = info.branches.map((item) => `<option value="${item.remote ? "remote" : "local"}:${escapeHTML(item.name)}">${item.remote ? "远程 · " : ""}${escapeHTML(item.name)}</option>`).join("");
    let groups = "";
    for (const [title, predicate] of [
      ["已暂存", (file) => file.staged],
      ["工作区改动", (file) => file.unstaged && file.status !== "??"],
      ["未跟踪", (file) => file.status === "??"],
    ]) {
      const files = info.files.map((file, index) => ({ file, index })).filter(({ file }) => predicate(file));
      if (!files.length) continue;
      groups += `<section class="git-file-group"><h3>${title}<span>${files.length}</span></h3>${files.map(({file,index}) => {
        const segments = file.path.split("/"), name = segments.pop(), dir = segments.join("/");
        return `<button type="button" class="git-file" data-file="${index}" title="${escapeHTML(file.path)}"><span class="git-file-icon" aria-hidden="true">▤</span><span class="git-file-name">${escapeHTML(name)}${dir ? `<small>${escapeHTML(dir)}</small>` : ""}</span><span class="git-file-status" title="Git 状态">${escapeHTML(file.status.trim())}</span></button>`;
      }).join("")}</section>`;
    }
    return `${info.upstream ? `<div class="git-hint">${escapeHTML(info.upstream)} · ↑${info.ahead} ↓${info.behind}</div>` : '<div class="git-hint">未关联上游分支</div>'}
      <select id="gitBranch" aria-label="切换分支" title="${escapeHTML(branch || "选择分支")}" ${blocked() || info.unborn ? "disabled" : ""}><option value="" selected>${escapeHTML(branch || "选择分支…")}</option>${branches}</select>
      <div class="git-actions"><button type="button" data-fetch ${blocked() || !info.hasRemote ? "disabled" : ""}>获取远程</button><button type="button" data-pull ${blocked() || !info.upstream ? "disabled" : ""}>拉取</button><button type="button" data-push ${blocked() || !info.upstream || info.ahead < 1 ? "disabled" : ""}>推送${info.ahead > 0 ? ` · ${info.ahead}` : ""}</button><button type="button" data-create ${blocked() || info.unborn ? "disabled" : ""}>新建分支</button></div>
      <form class="git-create-form hidden"><label for="gitNewBranch">新分支名称</label><input id="gitNewBranch" name="branch" required placeholder="feature/my-change" autocomplete="off"><button type="submit" ${blocked() ? "disabled" : ""}>创建并切换</button></form>
      ${task.codexActive ? '<div class="git-hint">Codex 执行期间暂停分支操作，文件改动仍可查看。</div>' : ""}
      ${busy ? '<div class="git-notice" role="status">正在执行 Git 操作…</div>' : ""}
      <div class="git-changes-heading">文件改动 <span>${info.files.length}</span></div>${groups || '<div class="git-clean">✓ 工作区干净</div>'}`;
  }

  async function scan() {
    if (!task || busy) return;
    const version = ++revision;
    loading = true; error = ""; info = null; render();
    try {
      const result = await api(route("/repositories"));
      if (version !== revision || !task) return;
      repositories = result.list || []; limited = result.limited;
      const saved = sessionStorage.getItem(`workflow.gitRepository.${task.id}`);
      selected = repositories.find((repo) => repo.path === selected)?.path || repositories.find((repo) => repo.path === saved)?.path || repositories[0]?.path || "";
      loading = false; render();
      if (repositories.length) await refresh();
    } catch (failure) {
      if (version !== revision) return;
      error = failure.message; loading = false; render();
    }
  }

  async function refresh({ silent = false } = {}) {
    if (!task || !repositories.length || busy) return;
    const version = revision, request = ++statusRequest, repo = selected;
    try {
      const result = await api(`${route()}?${query()}`);
      if (version !== revision || request !== statusRequest || repo !== selected) return;
      info = result; error = ""; render();
    } catch (failure) {
      if (version !== revision || request !== statusRequest || repo !== selected) return;
      if (!silent) { error = failure.message; render(); }
    }
  }

  async function operate(operation, branch = "") {
    if (!task || blocked()) return;
    const version = revision;
    busy = true; error = ""; notice = ""; ++statusRequest; render();
    try {
      await api(route(), { method: "POST", body: JSON.stringify({ repository: selected, operation, branch }) });
      if (version === revision) notice = "Git 操作已完成";
    } catch (failure) { if (version === revision) error = failure.message; }
    finally {
      if (version === revision) {
        busy = false;
        const operationError = error;
        await refresh();
        if (operationError) { error = operationError; render(); }
      }
    }
  }

  async function openDiff(file) {
    if (!task || !file) return;
    const request = ++diffRequest, version = revision;
    const repository = selected;
    diffData = null;
    dialog.innerHTML = `<div class="git-diff-head"><div><h2>${escapeHTML(file.path)}</h2><p>${escapeHTML(repository)}</p></div><button type="button" data-close aria-label="关闭差异">×</button></div><div class="git-diff-body" role="status">正在读取文件改动…</div>`;
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
    const params = query(); params.set("path", file.path);
    try {
      const result = await api(`${route("/diff")}?${params}`);
      if (version !== revision || request !== diffRequest || !dialog.open) return;
      diffData = result;
      diffTab = result.unstaged ? "unstaged" : result.staged ? "staged" : "content";
      renderDiff();
    } catch (failure) {
      if (request === diffRequest && dialog.open) dialog.querySelector(".git-diff-body").textContent = failure.message;
    }
  }

  function renderDiff() {
    const tabs = dialog.querySelector(".git-diff-tabs") || document.createElement("div");
    tabs.className = "git-diff-tabs";
    tabs.innerHTML = [["unstaged","工作区差异"],["staged","已暂存差异"],["content","未跟踪文件"]].filter(([key]) => key !== "content" ? Boolean(diffData[key]) : !diffData.unstaged && !diffData.staged).map(([key,label]) => `<button type="button" class="${key === diffTab ? "active" : ""}" data-tab="${key}">${label}</button>`).join("");
    if (!tabs.isConnected) dialog.querySelector(".git-diff-head").after(tabs);
    tabs.querySelectorAll("[data-tab]").forEach((button) => { button.onclick = () => { diffTab = button.dataset.tab; renderDiff(); }; });
    const body = dialog.querySelector(".git-diff-body");
    body.removeAttribute("role");
    if (diffData.binary) { body.textContent = "二进制文件，无法展示文本差异。"; return; }
    const text = diffData[diffTab] || "文件为空或没有可展示的文本改动。";
    body.innerHTML = `${diffData.truncated ? '<p class="git-hint">文件较大，仅展示前 2MB。</p>' : ""}<pre class="git-diff-code">${text.split("\n").map((line) => `<span class="${diffTab === "content" ? "" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : ""}">${escapeHTML(line) || " "}</span>`).join("\n")}</pre>`;
  }

  window.setInterval(() => {
    if (task && !document.hidden && !loading && !busy && !host.contains(document.activeElement)) void refresh({ silent: true });
  }, 10000);
  document.addEventListener("visibilitychange", () => {
    if (task && !document.hidden && !loading && !busy) void refresh({ silent: true });
  });

  return {
    setTask(next) {
      if (next?.id === task?.id) {
        const changed = next && (next.codexActive !== task.codexActive || next.status !== task.status);
        task = next;
        if (changed) { render(); if (!busy) void refresh({ silent: true }); }
        return;
      }
      task = next; ++revision; ++statusRequest; ++diffRequest;
      repositories = []; selected = ""; info = null; error = ""; notice = ""; busy = false; loading = false;
      if (dialog.open) dialog.close();
      document.body.classList.remove("git-drawer-open");
      render();
      if (task) void scan();
    },
  };
}
