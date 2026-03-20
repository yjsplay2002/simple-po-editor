import { getEntryStatus, parsePo, summarizeEntries } from "./po.js";

const STORAGE_KEYS = {
  displayName: "simple-po-editor.display-name",
  sessionId: "simple-po-editor.session-id"
};

const SHARED_DOC_LIMIT = 24;

const state = {
  currentDocId: "",
  currentFileName: "",
  dirty: false,
  displayName: loadDisplayName(),
  document: null,
  documentPassword: "3757",
  deleting: false,
  editPassword: "",
  entryStates: {},
  loading: false,
  lock: null,
  message: null,
  meta: null,
  saving: false,
  search: "",
  sessionId: loadSessionId(),
  sharedDocs: [],
  sharedDocsLoading: false,
  statusFilter: "all",
  storageMode: "checking"
};

const root = document.querySelector("#app");
let refs = {};
let heartbeatTimer = null;
let refreshTimer = null;
let sharedDocsTimer = null;
let sharedDocsRefreshToken = 0;
const rowAutosaveTimers = new Map();

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

function saveDisplayName() {
  localStorage.setItem(STORAGE_KEYS.displayName, state.displayName.trim());
}

function normalizeSharedDoc(item) {
  const meta = item?.meta || item;
  const id = typeof meta?.id === "string" ? meta.id.trim() : "";

  if (!id) {
    return null;
  }

  return {
    id,
    name: typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 120) : "Untitled translation",
    lock: item?.lock || null,
    storageMode: typeof meta?.storageMode === "string" ? meta.storageMode : "",
    updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : "",
    version: Number(meta?.version || 0)
  };
}

function sortSharedDocs(documents) {
  return [...documents].sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
}

function upsertSharedDoc(item) {
  const nextEntry = normalizeSharedDoc(item);

  if (!nextEntry) {
    return;
  }

  state.sharedDocs = sortSharedDocs([nextEntry, ...state.sharedDocs.filter((entry) => entry.id !== nextEntry.id)]).slice(
    0,
    SHARED_DOC_LIMIT
  );
}

function entryState(entryId) {
  if (!state.entryStates[entryId]) {
    state.entryStates[entryId] = {
      dirty: false,
      error: "",
      lastSavedAt: "",
      saving: false
    };
  }

  return state.entryStates[entryId];
}

function pendingEntryStates() {
  return Object.values(state.entryStates).filter((item) => item.dirty || item.saving || item.error);
}

function clearEntryTimers() {
  rowAutosaveTimers.forEach((timerId) => window.clearTimeout(timerId));
  rowAutosaveTimers.clear();
}

function queueEntryAutosave(entryId, delay = 700) {
  const currentTimer = rowAutosaveTimers.get(entryId);

  if (currentTimer) {
    window.clearTimeout(currentTimer);
  }

  const nextTimer = window.setTimeout(() => {
    rowAutosaveTimers.delete(entryId);
    void saveEntryTranslation(entryId);
  }, delay);

  rowAutosaveTimers.set(entryId, nextTimer);
}

function findDocumentEntry(entryId) {
  return state.document?.entries.find((entry) => entry.id === entryId) || null;
}

function copyTranslations(values = []) {
  return Array.isArray(values) ? values.map((value) => String(value ?? "")) : [""];
}

function sameTranslations(left = [], right = []) {
  return JSON.stringify(copyTranslations(left)) === JSON.stringify(copyTranslations(right));
}

function setMessage(kind, text) {
  state.message = text ? { kind, text } : null;
  renderNotice();
}

function currentDocLink(id = state.currentDocId) {
  return `${window.location.origin}${window.location.pathname}#/d/${id}`;
}

function goHome() {
  clearDocumentState();
  setRoute("");
  render();
  scheduleTimers();
  void refreshSharedDocs({ quiet: true });
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

function requestDocumentPassword(action) {
  const password = window.prompt(`${action}\nEnter the document password.`);

  if (password === null) {
    return null;
  }

  if (!password.trim()) {
    setMessage("warning", "Document password is required.");
    return null;
  }

  return password;
}

function storageSummary() {
  if (state.storageMode === "d1") {
    return "Shared documents are stored in Cloudflare D1 and stay available from any browser with the link.";
  }

  if (state.storageMode === "memory") {
    return "Local dev uses memory mode and resets on restart.";
  }

  return "Checking shared storage availability for this deployment.";
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
    const haystack = [entry.msgid, entry.msgidPlural, ...entry.msgstr, ...entry.comments.reference].join(" ").toLowerCase();

    if (state.statusFilter !== "all" && status !== state.statusFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    return haystack.includes(query);
  });
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

function hydrateDocumentFromPayload(payload) {
  state.document = payload.document;
  state.lock = payload.lock;
  state.meta = payload.meta;
  state.currentDocId = payload.meta.id;
  state.currentFileName = payload.meta.name;
  state.storageMode = payload.meta.storageMode;
  upsertSharedDoc(payload);
}

function clearDocumentState() {
  cleanupTimers();
  clearEntryTimers();
  state.currentDocId = "";
  state.currentFileName = "";
  state.deleting = false;
  state.document = null;
  state.editPassword = "";
  state.entryStates = {};
  state.lock = null;
  state.meta = null;
  state.dirty = false;
  state.saving = false;
}

async function detectStorageMode() {
  try {
    const payload = await apiFetch("/api/status");
    state.storageMode = payload.storageMode || "checking";
  } catch {
    state.storageMode = "checking";
  }

  render();
}

async function refreshSharedDocs({ quiet = false } = {}) {
  if (state.currentDocId || parseRoute()) {
    return;
  }

  const token = ++sharedDocsRefreshToken;
  state.sharedDocsLoading = true;

  if (!quiet || state.sharedDocs.length === 0) {
    render();
  }

  try {
    const payload = await apiFetch(
      `/api/documents?sessionId=${encodeURIComponent(state.sessionId)}&limit=${SHARED_DOC_LIMIT}`
    );

    if (token !== sharedDocsRefreshToken || state.currentDocId || parseRoute()) {
      return;
    }

    state.sharedDocs = sortSharedDocs((payload.documents || []).map(normalizeSharedDoc).filter(Boolean));
  } catch {
    // Keep the last successful shared list visible when the refresh fails.
  } finally {
    if (token !== sharedDocsRefreshToken || state.currentDocId || parseRoute()) {
      return;
    }

    state.sharedDocsLoading = false;
    render();
  }
}

function ensureEditPassword() {
  if (state.editPassword) {
    return state.editPassword;
  }

  const password = requestDocumentPassword(`Enable autosave for "${state.currentFileName}".`);

  if (!password) {
    return null;
  }

  state.editPassword = password;
  return password;
}

function mergeDocumentFromPayload(payload) {
  if (!state.document) {
    hydrateDocumentFromPayload(payload);
    return;
  }

  const localEntries = new Map(state.document.entries.map((entry) => [entry.id, entry]));
  const mergedEntries = payload.document.entries.map((remoteEntry) => {
    const localEntry = localEntries.get(remoteEntry.id);
    const currentState = state.entryStates[remoteEntry.id];

    if (!localEntry) {
      return remoteEntry;
    }

    if (currentState?.dirty || currentState?.saving) {
      if ((Number(remoteEntry.revision || 0) || 0) > (Number(localEntry.revision || 0) || 0)) {
        currentState.error = "Remote updates landed on this row. Your next autosave will overwrite them.";
      }

      return localEntry;
    }

    return remoteEntry;
  });

  state.document = {
    ...payload.document,
    entries: mergedEntries
  };
  state.meta = payload.meta;
  state.currentDocId = payload.meta.id;
  state.currentFileName = payload.meta.name;
  state.storageMode = payload.meta.storageMode;
  upsertSharedDoc(payload);
}

function applySavedEntry(payload, submittedTranslations) {
  if (!state.document) {
    return;
  }

  const rowState = entryState(payload.entry.id);
  const currentEntry = findDocumentEntry(payload.entry.id);

  if (!currentEntry) {
    return;
  }

  const hasNewerDraft = !sameTranslations(currentEntry.msgstr, submittedTranslations);

  currentEntry.revision = payload.entry.revision;
  currentEntry.updatedAt = payload.entry.updatedAt;
  currentEntry.lastEditorName = payload.entry.lastEditorName;

  if (!hasNewerDraft) {
    currentEntry.msgstr = copyTranslations(payload.entry.msgstr);
    rowState.dirty = false;
    rowState.error = "";
  } else {
    rowState.dirty = true;
  }

  rowState.lastSavedAt = payload.entry.updatedAt || "";
  state.meta = payload.meta;
  state.storageMode = payload.meta.storageMode || state.storageMode;
  upsertSharedDoc(payload);
}

async function loadDocument(id, { quiet = false } = {}) {
  if (!id) {
    clearDocumentState();
    render();
    scheduleTimers();
    void refreshSharedDocs({ quiet: true });
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
    const message = err instanceof Error ? err.message : String(err);
    const missingDocument = message === "Document not found.";

    clearDocumentState();

    if (missingDocument) {
      setRoute("");
      setMessage("warning", "Document not found. It is no longer in the shared document list.");
    } else {
      setMessage("warning", message);
    }

    render();
    scheduleTimers();
    void refreshSharedDocs({ quiet: true });
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
        password: state.documentPassword,
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
        : "Document created. Share the link and everyone will see live row updates."
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

async function refreshDocumentIfNeeded() {
  if (!state.currentDocId) {
    return;
  }

  try {
    const summary = await apiFetch(
      `/api/document?id=${encodeURIComponent(state.currentDocId)}&sessionId=${encodeURIComponent(state.sessionId)}&summary=1`
    );

    if (summary.meta.version !== state.meta?.version) {
      const payload = await apiFetch(
        `/api/document?id=${encodeURIComponent(state.currentDocId)}&sessionId=${encodeURIComponent(state.sessionId)}`
      );
      mergeDocumentFromPayload(payload);
      render();
    }
  } catch (err) {
    if ((err instanceof Error ? err.message : String(err)) === "Document not found.") {
      clearDocumentState();
      setRoute("");
      render();
      scheduleTimers();
      void refreshSharedDocs({ quiet: true });
      setMessage("warning", "This document was deleted.");
      return;
    }

    renderChrome();
  }
}

function cleanupTimers() {
  window.clearInterval(heartbeatTimer);
  window.clearInterval(refreshTimer);
  window.clearInterval(sharedDocsTimer);
  heartbeatTimer = null;
  refreshTimer = null;
  sharedDocsTimer = null;
}

function scheduleTimers() {
  cleanupTimers();

  if (state.currentDocId) {
    refreshTimer = window.setInterval(refreshDocumentIfNeeded, 2_000);
  }

  if (!state.currentDocId && !parseRoute()) {
    sharedDocsTimer = window.setInterval(() => {
      void refreshSharedDocs({ quiet: true });
    }, 15_000);
  }
}

function downloadCurrentPo() {
  if (!state.document || !state.currentDocId) {
    return;
  }

  const password = requestDocumentPassword(`Download "${state.currentFileName}".`);

  if (!password) {
    return;
  }

  fetch("/api/export", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      id: state.currentDocId,
      password
    })
  })
    .then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Request failed with ${response.status}`);
      }

      const text = await response.text();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${state.currentFileName || "translations"}.po`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("success", "Download started.");
    })
    .catch((err) => {
      setMessage("warning", err instanceof Error ? err.message : String(err));
      renderNotice();
    });
}

async function deleteCurrentDocument() {
  if (!state.currentDocId || state.deleting) {
    return;
  }

  const password = requestDocumentPassword(`Delete "${state.currentFileName}" permanently.`);

  if (!password) {
    return;
  }

  const confirmed = window.confirm(`"${state.currentFileName}" will be removed permanently. Continue?`);

  if (!confirmed) {
    return;
  }

  const deletedId = state.currentDocId;
  const deletedName = state.currentFileName || "Untitled translation";
  state.deleting = true;
  renderChrome();

  try {
    const payload = await apiFetch("/api/delete", {
      method: "POST",
      body: JSON.stringify({
        id: deletedId,
        password
      })
    });

    state.sharedDocs = state.sharedDocs.filter((entry) => entry.id !== deletedId);
    clearDocumentState();
    setRoute("");
    render();
    scheduleTimers();
    void refreshSharedDocs({ quiet: true });
    setMessage("success", `"${payload.deletedName || deletedName}" was deleted.`);
  } catch (err) {
    setMessage("warning", err instanceof Error ? err.message : String(err));
    renderNotice();
  } finally {
    state.deleting = false;
    renderChrome();
  }
}

function copyShareLink() {
  navigator.clipboard
    .writeText(currentDocLink())
    .then(() => setMessage("success", "Share link copied to clipboard."))
    .catch(() => setMessage("warning", "Clipboard copy failed. You can copy the URL manually."));
}

function formatSharedDocUpdatedAt(value) {
  if (!value) {
    return "Updated time unavailable";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
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
  const sharedItems = state.sharedDocs
    .map(
      (item) => `
        <div class="recent-item">
          <div class="recent-copy">
            <div class="recent-header">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="status-pill is-idle">Live sync</span>
            </div>
            <div class="recent-meta">
              <small class="mono">${escapeHtml(item.id)}</small>
              <small class="muted">Updated ${escapeHtml(formatSharedDocUpdatedAt(item.updatedAt))}</small>
              <small class="muted">v${escapeHtml(item.version || 1)}</small>
            </div>
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
          <div class="eyebrow">simple-po-editor / anonymous live sync</div>
          <h1>Edit PO files without passing zip files around.</h1>
          <p class="hero-copy">
            Import a <code>.po</code> file, create a shared document link, let one teammate hold the edit lock,
            and export the latest version back to <code>.po</code> whenever you need it.
          </p>

          <div class="stat-grid">
            <div class="stat-card">
              <span>Editing model</span>
              <strong>Live row sync</strong>
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
          <div class="field-group">
            <label for="document-password-input">Document password</label>
            <input
              id="document-password-input"
              class="input"
              type="password"
              value="${escapeAttribute(state.documentPassword)}"
              placeholder="Set the password used for save, download, and delete"
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
            Current storage mode: <span class="mono">${state.storageMode}</span>. ${escapeHtml(storageSummary())}
          </p>
        </aside>
      </div>

      <div id="notice"></div>

      <section class="hero-panel" style="margin-top: 28px;">
        <h2 class="section-title">Shared documents for everyone</h2>
        ${
          sharedItems
            ? `<div class="recent-list">${sharedItems}</div>`
            : state.sharedDocsLoading
              ? `<p class="muted">Loading the shared document board...</p>`
              : `<p class="muted">No shared documents yet. When anyone imports a <code>.po</code> file, it will appear here for everyone.</p>`
        }
      </section>
    </div>
  `;

  refs = {
    chooseFileButton: root.querySelector("#choose-file-button"),
    displayNameInput: root.querySelector("#display-name-input"),
    documentPasswordInput: root.querySelector("#document-password-input"),
    dropZone: root.querySelector("#drop-zone"),
    fileInput: root.querySelector("#file-input"),
    notice: root.querySelector("#notice")
  };

  refs.displayNameInput.addEventListener("input", (event) => {
    state.displayName = event.target.value;
    saveDisplayName();
  });

  refs.documentPasswordInput.addEventListener("input", (event) => {
    state.documentPassword = event.target.value;
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
          <span class="muted">Pulling the latest saved translation data and live sync state.</span>
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
            <span id="sync-badge" class="status-pill"></span>
            <span id="version-value" class="chip mono"></span>
          </div>
          <h1>${escapeHtml(state.currentFileName || "Untitled translation")}</h1>
          <p>Everyone can edit at once. Rows autosave after a short pause, and the sheet checks for remote updates every 2 seconds.</p>
        </div>
        <div class="toolbar-actions">
          <button id="home-button" class="button button-ghost">Home</button>
          <button id="copy-link-button" class="button button-ghost">Copy share link</button>
          <button id="delete-button" class="button button-danger">${state.deleting ? "Deleting..." : "Delete file"}</button>
          <button id="export-button" class="button button-ghost">Export .po</button>
        </div>
      </header>

      <div class="editor-grid">
        <section class="sheet-panel">
          <div class="sheet-controls">
            <div class="sheet-controls-top">
              <div class="field-group" style="margin-bottom: 0;">
                <label for="sidebar-display-name">Display name</label>
                <input id="sidebar-display-name" class="input" maxlength="80" value="${escapeAttribute(state.displayName)}" />
              </div>
              <div class="field-group" style="margin-bottom: 0;">
                <label for="search-input">Search</label>
                <input
                  id="search-input"
                  class="search-input"
                  placeholder="Search original, translation, or references..."
                  value="${escapeAttribute(state.search)}"
                />
              </div>
            </div>

            <div class="sheet-summary">
              <div class="filter-row">
                ${renderFilterButton("all", "All")}
                ${renderFilterButton("translated", "Translated")}
                ${renderFilterButton("untranslated", "Untranslated")}
                ${renderFilterButton("fuzzy", "Fuzzy")}
              </div>
              <div class="toolbar-meta">
                <span id="stats-pill" class="chip mono"></span>
                <span class="muted">Spreadsheet view with source, translation, and references only. Same-row conflicts use the most recent autosave.</span>
              </div>
            </div>
          </div>

          <div class="sheet-wrap">
            <div class="sheet-table">
              <div class="sheet-head">
                <span>Original Text</span>
                <span>Translation Text</span>
                <span>References</span>
              </div>
              <div id="sheet-body"></div>
            </div>
          </div>

          <div id="notice"></div>
        </section>
      </div>
    </div>
  `;

  refs = {
    copyLinkButton: root.querySelector("#copy-link-button"),
    deleteButton: root.querySelector("#delete-button"),
    displayNameInput: root.querySelector("#sidebar-display-name"),
    exportButton: root.querySelector("#export-button"),
    homeButton: root.querySelector("#home-button"),
    notice: root.querySelector("#notice"),
    searchInput: root.querySelector("#search-input"),
    sheetBody: root.querySelector("#sheet-body"),
    syncBadge: root.querySelector("#sync-badge"),
    statsPill: root.querySelector("#stats-pill"),
    versionValue: root.querySelector("#version-value")
  };

  refs.displayNameInput.addEventListener("input", (event) => {
    state.displayName = event.target.value;
    saveDisplayName();
  });

  refs.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderSpreadsheet();
  });

  refs.homeButton.addEventListener("click", goHome);
  refs.copyLinkButton.addEventListener("click", copyShareLink);
  refs.deleteButton.addEventListener("click", deleteCurrentDocument);
  refs.exportButton.addEventListener("click", downloadCurrentPo);

  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.statusFilter = button.dataset.filter;
      renderSpreadsheet();
      root.querySelectorAll("[data-filter]").forEach((target) => {
        target.classList.toggle("is-active", target.dataset.filter === state.statusFilter);
      });
    });
  });

  renderChrome();
  renderSpreadsheet();
  renderNotice();
}

function renderChrome() {
  if (!refs.syncBadge || !state.document || !state.meta) {
    return;
  }

  const summary = summarizeEntries(state.document.entries);
  const pendingRows = pendingEntryStates();
  const errorRows = pendingRows.filter((entry) => entry.error).length;
  const savingRows = pendingRows.filter((entry) => entry.saving).length;
  const dirtyRows = pendingRows.filter((entry) => entry.dirty).length;

  if (errorRows > 0) {
    refs.syncBadge.textContent = `${errorRows} row${errorRows > 1 ? "s" : ""} need attention`;
    refs.syncBadge.className = "status-pill is-readonly";
  } else if (savingRows > 0) {
    refs.syncBadge.textContent = `${savingRows} row${savingRows > 1 ? "s" : ""} autosaving`;
    refs.syncBadge.className = "status-pill is-editing";
  } else if (dirtyRows > 0) {
    refs.syncBadge.textContent = `${dirtyRows} row${dirtyRows > 1 ? "s" : ""} waiting to sync`;
    refs.syncBadge.className = "status-pill is-pending";
  } else {
    refs.syncBadge.textContent = "Live sync every 2s";
    refs.syncBadge.className = "status-pill is-idle";
  }

  refs.statsPill.textContent = `${summary.translated}/${summary.total} translated`;
  refs.versionValue.textContent = `v${state.meta.version}`;
  refs.homeButton.disabled = state.deleting;
  refs.copyLinkButton.disabled = state.deleting;
  refs.deleteButton.disabled = state.deleting || savingRows > 0;
  refs.deleteButton.textContent = state.deleting ? "Deleting..." : "Delete file";
  refs.exportButton.disabled = state.deleting;
}

function entryReferenceText(entry) {
  return entry.comments.reference.join("\n") || "No references";
}

function sheetRowClass(entry) {
  return `sheet-row is-${getEntryStatus(entry)}`;
}

function updateEntryTranslation(entryId, index, value, row) {
  if (!state.document) {
    return;
  }

  const entry = findDocumentEntry(entryId);

  if (!entry) {
    return;
  }

  entry.msgstr[index] = value;
  const currentState = entryState(entryId);
  currentState.dirty = true;
  currentState.error = "";
  queueEntryAutosave(entryId);

  if (row) {
    row.className = sheetRowClass(entry);
  }

  state.dirty = true;
  renderChrome();
}

async function saveEntryTranslation(entryId) {
  if (!state.document || !state.currentDocId) {
    return;
  }

  const entry = findDocumentEntry(entryId);

  if (!entry) {
    return;
  }

  const currentState = entryState(entryId);

  if (currentState.saving) {
    return;
  }

  const password = ensureEditPassword();

  if (!password) {
    currentState.error = "Autosave is waiting for the document password.";
    renderSpreadsheet();
    renderChrome();
    return;
  }

  const submittedTranslations = copyTranslations(entry.msgstr);
  currentState.saving = true;
  currentState.error = "";
  renderSpreadsheet();
  renderChrome();

  try {
    const payload = await apiFetch("/api/entry-save", {
      method: "POST",
      body: JSON.stringify({
        displayName: defaultDisplayName(),
        entryId,
        id: state.currentDocId,
        msgstr: submittedTranslations,
        password
      })
    });

    applySavedEntry(payload, submittedTranslations);
    currentState.lastSavedAt = payload.entry.updatedAt || "";
    currentState.saving = false;

    if (currentState.dirty) {
      queueEntryAutosave(entryId, 250);
    }
  } catch (err) {
    currentState.saving = false;
    currentState.error = err instanceof Error ? err.message : String(err);

    if (currentState.error === "Document password is incorrect." || currentState.error === "Document password is required.") {
      state.editPassword = "";
      currentState.error = "Autosave paused. Re-enter the document password by typing in this row again.";
    }
  }

  renderSpreadsheet();
  renderChrome();
}

function entrySyncLabel(entry) {
  const currentState = state.entryStates[entry.id];

  if (currentState?.error) {
    return currentState.error;
  }

  if (currentState?.saving) {
    return "Autosaving...";
  }

  if (currentState?.dirty) {
    return "Waiting to sync...";
  }

  if (entry.lastEditorName && entry.updatedAt) {
    return `Synced by ${entry.lastEditorName} at ${formatSharedDocUpdatedAt(entry.updatedAt)}`;
  }

  return "Ready for live edits";
}

function entrySyncClass(entry) {
  const currentState = state.entryStates[entry.id];

  if (currentState?.error) {
    return "is-error";
  }

  if (currentState?.saving) {
    return "is-saving";
  }

  if (currentState?.dirty) {
    return "is-pending";
  }

  return "is-idle";
}

function renderSpreadsheet() {
  if (!refs.sheetBody || !state.document) {
    return;
  }

  const visibleEntries = filteredEntries();

  if (visibleEntries.length === 0) {
    refs.sheetBody.innerHTML = `
      <div class="sheet-empty">
        <strong>No entries match this filter.</strong>
        <span class="muted">Try a different search query or switch the status filter.</span>
      </div>
    `;
    return;
  }

  refs.sheetBody.innerHTML = visibleEntries
    .map((entry, rowIndex) => {
      const translationFields = entry.msgstr
        .map(
          (value, index) => `
            <div class="sheet-field">
              <label class="sheet-field-label" for="msgstr-${rowIndex}-${index}">
                ${entry.msgidPlural || entry.msgstr.length > 1 ? `Plural form ${index}` : "Translation"}
              </label>
              <textarea
                id="msgstr-${rowIndex}-${index}"
                class="textarea sheet-textarea"
                data-entry-id="${escapeAttribute(entry.id)}"
                data-msgstr-index="${index}"
              >${escapeHtml(value)}</textarea>
            </div>
          `
        )
        .join("");

      return `
        <div class="${sheetRowClass(entry)}">
          <div class="sheet-cell" data-col="Original Text">
            <div class="sheet-source">${escapeHtml(entry.msgid || "(empty msgid)")}</div>
            ${entry.msgidPlural ? `<div class="sheet-subcopy">Plural: ${escapeHtml(entry.msgidPlural)}</div>` : ""}
          </div>
          <div class="sheet-cell" data-col="Translation Text">
            <div class="sheet-translation-stack">${translationFields}</div>
            <div class="sheet-row-status ${entrySyncClass(entry)}">${escapeHtml(entrySyncLabel(entry))}</div>
          </div>
          <div class="sheet-cell" data-col="References">
            <div class="sheet-reference ${entry.comments.reference.length ? "" : "is-empty"}">${escapeHtml(entryReferenceText(entry))}</div>
          </div>
        </div>
      `;
    })
    .join("");

  refs.sheetBody.querySelectorAll("[data-entry-id][data-msgstr-index]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      const row = textarea.closest(".sheet-row");
      updateEntryTranslation(textarea.dataset.entryId, Number(textarea.dataset.msgstrIndex), textarea.value, row);
    });
  });
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
    setMessage("info", "Rows save automatically after a short pause.");
    renderNotice();
  }
});

async function boot() {
  await detectStorageMode();
  const routedId = parseRoute();

  if (routedId) {
    await loadDocument(routedId);
    return;
  }

  render();
  scheduleTimers();
  await refreshSharedDocs({ quiet: true });
}

boot();
