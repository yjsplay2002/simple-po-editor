import { compilePo, getEntryStatus, parsePo, summarizeEntries } from "./po.js";

const STORAGE_KEYS = {
  displayName: "simple-po-editor.display-name",
  recentDocs: "simple-po-editor.recent-docs",
  sessionId: "simple-po-editor.session-id"
};

const state = {
  currentDocId: "",
  currentFileName: "",
  dirty: false,
  displayName: loadDisplayName(),
  document: null,
  loading: false,
  lock: null,
  message: null,
  meta: null,
  recentDocs: loadRecentDocs(),
  saving: false,
  search: "",
  selectedEntryId: "",
  sessionId: loadSessionId(),
  statusFilter: "all",
  storageMode: "memory"
};

const root = document.querySelector("#app");
let refs = {};
let heartbeatTimer = null;
let refreshTimer = null;

function loadSessionId() {
  const existing = localStorage.getItem(STORAGE_KEYS.sessionId);

  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID().replace(/-/g, "");
  localStorage.setItem(STORAGE_KEYS.sessionId, created);
  return created;
}

function loadDisplayName() {
  return localStorage.getItem(STORAGE_KEYS.displayName) || "";
}

function loadRecentDocs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.recentDocs) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentDocs() {
  localStorage.setItem(STORAGE_KEYS.recentDocs, JSON.stringify(state.recentDocs.slice(0, 8)));
}

function saveDisplayName() {
  localStorage.setItem(STORAGE_KEYS.displayName, state.displayName.trim());
}

function setMessage(kind, text) {
  state.message = text ? { kind, text } : null;
  renderNotice();
}

function currentDocLink(id = state.currentDocId) {
  return `${window.location.origin}${window.location.pathname}#/d/${id}`;
}

function parseRoute() {
  const match = window.location.hash.match(/^#\/d\/([a-z0-9]+)/i);
  return match ? match[1] : "";
}

function setRoute(id) {
  window.location.hash = id ? `#/d/${id}` : "";
}

function defaultDisplayName() {
  return state.displayName.trim() || `Editor ${state.sessionId.slice(0, 4)}`;
}

function isEditing() {
  return Boolean(state.lock?.isActive && state.lock?.isMine);
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}...` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function filteredEntries() {
  if (!state.document) {
    return [];
  }

  const query = state.search.trim().toLowerCase();

  return state.document.entries.filter((entry) => {
    const status = getEntryStatus(entry);
    const haystack = [entry.msgctxt, entry.msgid, entry.msgidPlural, ...entry.msgstr].join(" ").toLowerCase();

    if (state.statusFilter !== "all" && status !== state.statusFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    return haystack.includes(query);
  });
}

function selectedEntry() {
  if (!state.document) {
    return null;
  }

  const visibleEntries = filteredEntries();
  const selected = state.document.entries.find((entry) => entry.id === state.selectedEntryId);

  if (selected && visibleEntries.some((entry) => entry.id === selected.id)) {
    return selected;
  }

  return visibleEntries[0] || state.document.entries[0] || null;
}

function ensureSelectedEntry() {
  const entry = selectedEntry();
  state.selectedEntryId = entry?.id || "";
}

async function apiFetch(url, options = {}) {
  const mergedHeaders = new Headers(options.headers || {});

  if (options.body && !mergedHeaders.has("content-type")) {
    mergedHeaders.set("content-type", "application/json");
  }

  const response = await fetch(url, {
    ...options,
    headers: mergedHeaders
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Request failed with ${response.status}`);
  }

  return payload;
}

function upsertRecentDoc(id, name) {
  state.recentDocs = [{ id, name, openedAt: new Date().toISOString() }, ...state.recentDocs.filter((entry) => entry.id !== id)].slice(
    0,
    8
  );
  saveRecentDocs();
}

function hydrateDocumentFromPayload(payload) {
  state.document = payload.document;
  state.lock = payload.lock;
  state.meta = payload.meta;
  state.currentDocId = payload.meta.id;
  state.currentFileName = payload.meta.name;
  state.storageMode = payload.meta.storageMode;
  ensureSelectedEntry();
  upsertRecentDoc(payload.meta.id, payload.meta.name);
}

function applyMetaAndLockFromPayload(payload) {
  state.lock = payload.lock;
  state.meta = payload.meta;
  state.currentDocId = payload.meta.id;
  state.currentFileName = payload.meta.name;
  state.storageMode = payload.meta.storageMode;
  upsertRecentDoc(payload.meta.id, payload.meta.name);
}

function clearDocumentState() {
  cleanupTimers();
  state.currentDocId = "";
  state.currentFileName = "";
  state.document = null;
  state.lock = null;
  state.meta = null;
  state.storageMode = "memory";
  state.dirty = false;
}

async function loadDocument(id, { quiet = false } = {}) {
  if (!id) {
    clearDocumentState();
    render();
    return;
  }

  state.loading = !quiet;
  render();

  try {
    const payload = await apiFetch(
      `/api/document?id=${encodeURIComponent(id)}&sessionId=${encodeURIComponent(state.sessionId)}`
    );
    hydrateDocumentFromPayload(payload);
    state.dirty = false;
    render();
    scheduleTimers();
  } catch (err) {
    clearDocumentState();
    setMessage("warning", err instanceof Error ? err.message : String(err));
    render();
  } finally {
    state.loading = false;
    renderChrome();
  }
}

async function createFromPoFile(file) {
  if (!file) {
    return;
  }

  state.loading = true;
  render();

  try {
    const content = await file.text();
    const parsed = parsePo(content);
    const payload = await apiFetch("/api/create", {
      method: "POST",
      body: JSON.stringify({
        displayName: defaultDisplayName(),
        document: parsed,
        name: file.name.replace(/\.po$/i, "") || "Untitled translation",
        sessionId: state.sessionId
      })
    });

    hydrateDocumentFromPayload(payload);
    state.dirty = false;
    setRoute(payload.meta.id);
    setMessage(
      payload.meta.storageMode === "memory" ? "info" : "success",
      payload.meta.storageMode === "memory"
        ? "Document created in local memory mode. Add a D1 binding before sharing for durable team storage."
        : "Document created. Share the link and have one teammate take the editing lock."
    );
    render();
    scheduleTimers();
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
    renderNotice();
  } finally {
    state.loading = false;
    render();
  }
}

async function requestLock() {
  if (!state.currentDocId || isEditing()) {
    return;
  }

  try {
    const payload = await apiFetch("/api/lock", {
      method: "POST",
      body: JSON.stringify({
        displayName: defaultDisplayName(),
        id: state.currentDocId,
        sessionId: state.sessionId
      })
    });

    hydrateDocumentFromPayload(payload);

    if (payload.lock.isMine) {
      setMessage("success", "Editing lock acquired.");
    } else {
      setMessage("warning", `${payload.lock.holderName || "Another editor"} is currently editing this file.`);
    }

    render();
    scheduleTimers();
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
  }
}

async function releaseLock() {
  if (!state.currentDocId || !state.lock?.isMine) {
    return;
  }

  try {
    const payload = await apiFetch("/api/release", {
      method: "POST",
      body: JSON.stringify({
        id: state.currentDocId,
        sessionId: state.sessionId
      })
    });
    hydrateDocumentFromPayload(payload);
    setMessage("info", "Editing lock released.");
    render();
    scheduleTimers();
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
  }
}

async function refreshLock() {
  if (!state.currentDocId || !state.lock?.isMine) {
    return;
  }

  try {
    const payload = await apiFetch("/api/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        displayName: defaultDisplayName(),
        id: state.currentDocId,
        sessionId: state.sessionId
      })
    });

    if (state.dirty && state.document) {
      applyMetaAndLockFromPayload(payload);
    } else {
      hydrateDocumentFromPayload(payload);
    }

    renderChrome();
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
    cleanupTimers();
  }
}

async function refreshDocumentIfNeeded() {
  if (!state.currentDocId || isEditing()) {
    return;
  }

  try {
    const payload = await apiFetch(
      `/api/document?id=${encodeURIComponent(state.currentDocId)}&sessionId=${encodeURIComponent(state.sessionId)}`
    );
    const changed = payload.meta.version !== state.meta?.version;

    hydrateDocumentFromPayload(payload);

    if (changed && !state.dirty) {
      setMessage("info", "The document view was refreshed with the latest saved changes.");
    }

    render();
  } catch {
    renderChrome();
  }
}

function cleanupTimers() {
  window.clearInterval(heartbeatTimer);
  window.clearInterval(refreshTimer);
  heartbeatTimer = null;
  refreshTimer = null;
}

function scheduleTimers() {
  cleanupTimers();

  if (state.currentDocId && isEditing()) {
    heartbeatTimer = window.setInterval(refreshLock, 25_000);
  }

  if (state.currentDocId && !isEditing()) {
    refreshTimer = window.setInterval(refreshDocumentIfNeeded, 15_000);
  }
}

function downloadCurrentPo() {
  if (!state.document) {
    return;
  }

  const blob = new Blob([compilePo(state.document)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.currentFileName || "translations"}.po`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function saveDocument() {
  if (!state.document || !state.currentDocId || !isEditing()) {
    return;
  }

  state.saving = true;
  renderChrome();

  try {
    const payload = await apiFetch("/api/save", {
      method: "POST",
      body: JSON.stringify({
        displayName: defaultDisplayName(),
        document: state.document,
        id: state.currentDocId,
        sessionId: state.sessionId,
        version: state.meta?.version || 0
      })
    });

    hydrateDocumentFromPayload(payload);
    state.dirty = false;
    setMessage("success", "Changes saved.");
    render();
    scheduleTimers();
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
    renderNotice();
  } finally {
    state.saving = false;
    renderChrome();
  }
}

function updateSelectedEntry(mutator) {
  const entry = selectedEntry();

  if (!entry || !isEditing()) {
    return;
  }

  mutator(entry);
  state.dirty = true;
  renderEntryList();
  renderChrome();
  renderSelectedEntrySummary();
}

function copyShareLink() {
  navigator.clipboard
    .writeText(currentDocLink())
    .then(() => setMessage("success", "Share link copied to clipboard."))
    .catch(() => setMessage("warning", "Clipboard copy failed. You can copy the URL manually."));
}

function lockLabel() {
  if (!state.lock?.isActive) {
    return "No active lock";
  }

  if (state.lock.isMine) {
    return "You hold the editing lock";
  }

  const expiresIn = Math.max(0, Math.ceil((state.lock.expiresAt - Date.now()) / 1000));
  return `${state.lock.holderName} is editing, expires in ${expiresIn}s`;
}

function renderNotice() {
  if (!refs.notice) {
    return;
  }

  if (!state.message) {
    refs.notice.innerHTML = "";
    refs.notice.className = "";
    return;
  }

  refs.notice.className = `status-banner ${state.message.kind === "warning" ? "is-warning" : state.message.kind === "success" ? "is-success" : "is-info"}`;
  refs.notice.textContent = state.message.text;
}

function renderHome() {
  const recentItems = state.recentDocs
    .map(
      (item) => `
        <div class="recent-item">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <small class="mono">${escapeHtml(item.id)}</small>
          </div>
          <button class="button button-ghost" data-open-doc="${item.id}">Open</button>
        </div>
      `
    )
    .join("");

  root.innerHTML = `
    <div class="shell hero">
      <div class="hero-grid">
        <section>
          <div class="eyebrow">simple-po-editor / anonymous lock flow</div>
          <h1>Edit PO files without passing zip files around.</h1>
          <p class="hero-copy">
            Import a <code>.po</code> file, create a shared document link, let one teammate hold the edit lock,
            and export the latest version back to <code>.po</code> whenever you need it.
          </p>

          <div class="stat-grid">
            <div class="stat-card">
              <span>Editing model</span>
              <strong>1 active lock</strong>
            </div>
            <div class="stat-card">
              <span>Sign-in flow</span>
              <strong>None</strong>
            </div>
            <div class="stat-card">
              <span>Export format</span>
              <strong>.po</strong>
            </div>
          </div>
        </section>

        <aside class="hero-panel">
          <h2 class="section-title">Create a shared translation document</h2>
          <div class="field-group">
            <label for="display-name-input">Display name</label>
            <input
              id="display-name-input"
              class="input"
              maxlength="80"
              value="${escapeAttribute(state.displayName)}"
              placeholder="For example: Mina, Lucas, QA desk"
            />
          </div>
          <input id="file-input" class="visually-hidden" type="file" accept=".po,text/plain" />
          <button id="choose-file-button" class="button button-primary" ${state.loading ? "disabled" : ""}>
            ${state.loading ? "Importing..." : "Choose .po file"}
          </button>

          <div id="drop-zone" class="drop-zone" tabindex="0">
            <div>
              <strong>Drop a PO file here</strong>
              <span class="muted">The imported content becomes a shareable document with lock-based editing.</span>
            </div>
          </div>

          <p class="muted" style="margin-top: 16px;">
            Current storage mode: <span class="mono">${state.storageMode}</span>. Local dev uses memory mode and resets on restart.
          </p>
        </aside>
      </div>

      <div id="notice"></div>

      <section class="hero-panel" style="margin-top: 28px;">
        <h2 class="section-title">Recent documents on this browser</h2>
        ${
          recentItems
            ? `<div class="recent-list">${recentItems}</div>`
            : `<p class="muted">No recent documents yet. Import a <code>.po</code> file to create the first share link.</p>`
        }
      </section>
    </div>
  `;

  refs = {
    chooseFileButton: root.querySelector("#choose-file-button"),
    displayNameInput: root.querySelector("#display-name-input"),
    dropZone: root.querySelector("#drop-zone"),
    fileInput: root.querySelector("#file-input"),
    notice: root.querySelector("#notice")
  };

  refs.displayNameInput.addEventListener("input", (event) => {
    state.displayName = event.target.value;
    saveDisplayName();
  });

  refs.chooseFileButton.addEventListener("click", () => refs.fileInput.click());
  refs.fileInput.addEventListener("change", (event) => createFromPoFile(event.target.files?.[0]));

  ["dragenter", "dragover"].forEach((type) => {
    refs.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      refs.dropZone.classList.add("is-active");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    refs.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      refs.dropZone.classList.remove("is-active");
    });
  });

  refs.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    createFromPoFile(file);
  });

  refs.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      refs.fileInput.click();
    }
  });

  root.querySelectorAll("[data-open-doc]").forEach((button) => {
    button.addEventListener("click", () => setRoute(button.dataset.openDoc));
  });

  renderNotice();
}

function renderFilterButton(value, label) {
  return `<button class="filter-button ${state.statusFilter === value ? "is-active" : ""}" data-filter="${value}">${label}</button>`;
}

function renderLoading() {
  root.innerHTML = `
    <div class="shell hero">
      <div class="empty-state">
        <div>
          <strong>Loading document...</strong>
          <span class="muted">Pulling the latest saved translation data and lock state.</span>
        </div>
      </div>
    </div>
  `;
}

function renderEditorShell() {
  root.innerHTML = `
    <div class="shell editor-shell">
      <header class="toolbar">
        <div>
          <div class="toolbar-meta">
            <span class="chip">${state.storageMode === "d1" ? "Cloud persistence ready" : "Memory mode"}</span>
            <span id="lock-badge" class="status-pill"></span>
            <span id="version-value" class="chip mono"></span>
          </div>
          <h1>${escapeHtml(state.currentFileName || "Untitled translation")}</h1>
          <p>Share this URL with the team. One person edits, everyone else stays read-only until the lock is free.</p>
        </div>
        <div class="toolbar-actions">
          <button id="copy-link-button" class="button button-ghost">Copy share link</button>
          <button id="take-lock-button" class="button button-primary">${isEditing() ? "You are editing" : "Take editing lock"}</button>
          <button id="release-lock-button" class="button button-danger">Release lock</button>
          <button id="export-button" class="button button-ghost">Export .po</button>
          <button id="save-button" class="button button-primary">Save changes</button>
        </div>
      </header>

      <div class="editor-grid">
        <aside class="sidebar">
          <div class="sidebar-top">
            <div class="field-group" style="margin-bottom: 0;">
              <label for="sidebar-display-name">Display name</label>
              <input id="sidebar-display-name" class="input" maxlength="80" value="${escapeAttribute(state.displayName)}" />
            </div>
            <input id="search-input" class="search-input" placeholder="Search msgid, msgctxt, translation..." value="${escapeAttribute(
              state.search
            )}" />
            <div class="filter-row">
              ${renderFilterButton("all", "All")}
              ${renderFilterButton("translated", "Translated")}
              ${renderFilterButton("untranslated", "Untranslated")}
              ${renderFilterButton("fuzzy", "Fuzzy")}
            </div>
          </div>
          <div id="entry-list" class="sidebar-list"></div>
        </aside>

        <section class="detail">
          <div class="detail-head">
            <div>
              <h2 id="detail-title">Entry</h2>
              <p id="detail-subtitle" class="muted"></p>
            </div>
            <div class="toolbar-meta">
              <span id="stats-pill" class="chip mono"></span>
            </div>
          </div>
          <div id="detail-grid" class="detail-grid"></div>
          <div id="notice"></div>
        </section>
      </div>
    </div>
  `;

  refs = {
    copyLinkButton: root.querySelector("#copy-link-button"),
    detailGrid: root.querySelector("#detail-grid"),
    detailSubtitle: root.querySelector("#detail-subtitle"),
    detailTitle: root.querySelector("#detail-title"),
    displayNameInput: root.querySelector("#sidebar-display-name"),
    entryList: root.querySelector("#entry-list"),
    exportButton: root.querySelector("#export-button"),
    lockBadge: root.querySelector("#lock-badge"),
    notice: root.querySelector("#notice"),
    releaseLockButton: root.querySelector("#release-lock-button"),
    saveButton: root.querySelector("#save-button"),
    searchInput: root.querySelector("#search-input"),
    statsPill: root.querySelector("#stats-pill"),
    takeLockButton: root.querySelector("#take-lock-button"),
    versionValue: root.querySelector("#version-value")
  };

  refs.displayNameInput.addEventListener("input", (event) => {
    state.displayName = event.target.value;
    saveDisplayName();
  });

  refs.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    ensureSelectedEntry();
    renderEntryList();
    renderEntryEditor();
  });

  refs.copyLinkButton.addEventListener("click", copyShareLink);
  refs.takeLockButton.addEventListener("click", requestLock);
  refs.releaseLockButton.addEventListener("click", releaseLock);
  refs.exportButton.addEventListener("click", downloadCurrentPo);
  refs.saveButton.addEventListener("click", saveDocument);

  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.statusFilter = button.dataset.filter;
      ensureSelectedEntry();
      renderEntryList();
      renderEntryEditor();
      root.querySelectorAll("[data-filter]").forEach((target) => {
        target.classList.toggle("is-active", target.dataset.filter === state.statusFilter);
      });
    });
  });

  renderChrome();
  renderEntryList();
  renderEntryEditor();
  renderNotice();
}

function renderChrome() {
  if (!refs.lockBadge || !state.document || !state.meta) {
    return;
  }

  const summary = summarizeEntries(state.document.entries);

  refs.lockBadge.textContent = lockLabel();
  refs.lockBadge.className = `status-pill ${isEditing() ? "is-editing" : "is-readonly"}`;
  refs.statsPill.textContent = `${summary.translated}/${summary.total} translated`;
  refs.versionValue.textContent = `v${state.meta.version}`;
  refs.takeLockButton.disabled = isEditing() || Boolean(state.lock?.isActive && !state.lock?.isMine);
  refs.takeLockButton.textContent = isEditing() ? "You are editing" : "Take editing lock";
  refs.releaseLockButton.disabled = !isEditing();
  refs.saveButton.disabled = !isEditing() || !state.dirty || state.saving;
  refs.saveButton.textContent = state.saving ? "Saving..." : state.dirty ? "Save changes" : "Saved";
}

function renderEntryList() {
  if (!refs.entryList || !state.document) {
    return;
  }

  ensureSelectedEntry();
  const visibleEntries = filteredEntries();

  if (visibleEntries.length === 0) {
    refs.entryList.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>No entries match this filter.</strong>
          <span class="muted">Try a different search query or switch the status filter.</span>
        </div>
      </div>
    `;
    return;
  }

  refs.entryList.innerHTML = visibleEntries
    .map((entry) => {
      const status = getEntryStatus(entry);
      const translationPreview = entry.msgstr.find((value) => value.trim()) || "No translation yet";
      const flags = entry.comments.flag.length ? entry.comments.flag.join(", ") : status;
      return `
        <button class="entry-item is-${status} ${entry.id === state.selectedEntryId ? "is-selected" : ""}" data-entry-id="${entry.id}">
          <strong>${escapeHtml(entry.msgid || "(header)")}</strong>
          <div class="entry-meta">
            ${entry.msgctxt ? `<span class="mono">${escapeHtml(entry.msgctxt)}</span>` : ""}
            <span>${escapeHtml(flags)}</span>
          </div>
          <span class="muted">${escapeHtml(truncate(translationPreview, 84))}</span>
        </button>
      `;
    })
    .join("");

  refs.entryList.querySelectorAll("[data-entry-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedEntryId = button.dataset.entryId;
      renderEntryList();
      renderEntryEditor();
    });
  });
}

function renderMetaBlock(label, value) {
  return `
    <div class="meta-block">
      <strong class="meta-label">${escapeHtml(label)}</strong>
      <div class="source-copy">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderEntryEditor() {
  if (!refs.detailGrid || !state.document) {
    return;
  }

  const entry = selectedEntry();

  if (!entry) {
    refs.detailTitle.textContent = "No entry selected";
    refs.detailSubtitle.textContent = "";
    refs.detailGrid.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>Select a translation row.</strong>
          <span class="muted">The details panel shows source text, translation, and comments.</span>
        </div>
      </div>
    `;
    return;
  }

  state.selectedEntryId = entry.id;
  const translationInputs = entry.msgstr
    .map(
      (value, index) => `
        <div class="translation-group">
          <label for="msgstr-${index}">${entry.msgidPlural ? `Plural form ${index}` : "Translation"}</label>
          <textarea id="msgstr-${index}" class="textarea" data-msgstr-index="${index}" ${!isEditing() ? "readonly" : ""}>${escapeHtml(
            value
          )}</textarea>
        </div>
      `
    )
    .join("");

  refs.detailTitle.textContent = entry.msgid || "Header";
  renderSelectedEntrySummary();
  refs.detailGrid.innerHTML = `
    <div class="detail-card">
      <h3>Source text</h3>
      <div class="source-copy">${escapeHtml(entry.msgid || "(empty msgid)")}</div>
      ${entry.msgidPlural ? `<div class="source-copy muted" style="margin-top: 12px;">Plural: ${escapeHtml(entry.msgidPlural)}</div>` : ""}
    </div>
    <div class="detail-card">
      <h3>Translation</h3>
      <div class="translation-group">
        ${translationInputs}
      </div>
    </div>
    <div class="detail-card">
      <h3>Entry metadata</h3>
      <div class="meta-list">
        ${renderMetaBlock("Context", entry.msgctxt || "No context")}
        ${renderMetaBlock("References", entry.comments.reference.join("\n") || "No references")}
        ${renderMetaBlock("Flags", entry.comments.flag.join("\n") || "No flags")}
        ${renderMetaBlock("Translator comments", entry.comments.translator.join("\n") || "No translator comments")}
        ${renderMetaBlock("Extracted comments", entry.comments.extracted.join("\n") || "No extracted comments")}
      </div>
    </div>
  `;

  refs.detailGrid.querySelectorAll("[data-msgstr-index]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      const index = Number(textarea.dataset.msgstrIndex);
      updateSelectedEntry((target) => {
        target.msgstr[index] = textarea.value;
      });
    });
  });
}

function renderSelectedEntrySummary() {
  if (!refs.detailTitle || !refs.detailSubtitle) {
    return;
  }

  const entry = selectedEntry();

  if (!entry) {
    refs.detailTitle.textContent = "No entry selected";
    refs.detailSubtitle.textContent = "";
    return;
  }

  const status = getEntryStatus(entry);
  refs.detailTitle.textContent = entry.msgid || "Header";
  refs.detailSubtitle.textContent = `${status.toUpperCase()}${entry.msgctxt ? ` / ${entry.msgctxt}` : ""}`;
}

function render() {
  if (state.loading && state.currentDocId && !state.document) {
    renderLoading();
    return;
  }

  if (!state.currentDocId || !state.document) {
    renderHome();
    return;
  }

  renderEditorShell();
}

window.addEventListener("hashchange", async () => {
  const nextId = parseRoute();

  if (nextId !== state.currentDocId) {
    await loadDocument(nextId);
  }
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveDocument();
  }
});

window.addEventListener("beforeunload", () => {
  if (!state.currentDocId || !isEditing()) {
    return;
  }

  navigator.sendBeacon(
    "/api/release",
    new Blob(
      [
        JSON.stringify({
          id: state.currentDocId,
          sessionId: state.sessionId
        })
      ],
      { type: "application/json" }
    )
  );
});

async function boot() {
  const routedId = parseRoute();

  if (routedId) {
    await loadDocument(routedId);
    return;
  }

  render();
}

boot();
