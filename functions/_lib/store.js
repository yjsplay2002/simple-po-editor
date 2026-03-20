const LOCK_TTL_MS = 90_000;
const DEFAULT_DOCUMENT_PASSWORD = "3757";
const DEFAULT_PASSWORD_HASH_KEY = Symbol.for("simple-po-editor.default-password-hash");
const MEMORY_STORE_KEY = Symbol.for("simple-po-editor.memory");
const SCHEMA_READY_KEY = Symbol.for("simple-po-editor.schema-ready");

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content_json TEXT NOT NULL,
    password_hash TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lock_owner_id TEXT,
    lock_owner_name TEXT,
    lock_expires_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at)"
];

const SCHEMA_MIGRATIONS = ["ALTER TABLE documents ADD COLUMN password_hash TEXT"];

export class StorageConfigError extends Error {
  constructor(message = "Persistent storage is not configured.") {
    super(message);
    this.name = "StorageConfigError";
  }
}

export class DocumentPasswordError extends Error {
  constructor(message = "Document password is incorrect.") {
    super(message);
    this.name = "DocumentPasswordError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function allowMemoryStore(env) {
  return env?.ALLOW_MEMORY_STORE === true || env?.ALLOW_MEMORY_STORE === "true";
}

function memoryStore() {
  if (!globalThis[MEMORY_STORE_KEY]) {
    globalThis[MEMORY_STORE_KEY] = {
      documents: new Map()
    };
  }

  return globalThis[MEMORY_STORE_KEY];
}

function cleanString(value, limit = 6000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function cleanCommentList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => cleanString(item))
        .filter(Boolean)
        .slice(0, 24)
    : [];
}

function isIgnorableSchemaError(err) {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

function sanitizeEntry(entry, index) {
  const msgstr = Array.isArray(entry?.msgstr) && entry.msgstr.length > 0 ? entry.msgstr : [""];

  return {
    id: cleanString(entry?.id, 120) || `entry-${index + 1}`,
    msgctxt: cleanString(entry?.msgctxt),
    msgid: cleanString(entry?.msgid),
    msgidPlural: cleanString(entry?.msgidPlural),
    msgstr: msgstr.map((item) => cleanString(item)).slice(0, 8),
    comments: {
      translator: cleanCommentList(entry?.comments?.translator),
      extracted: cleanCommentList(entry?.comments?.extracted),
      reference: cleanCommentList(entry?.comments?.reference),
      flag: cleanCommentList(entry?.comments?.flag),
      previous: cleanCommentList(entry?.comments?.previous)
    },
    obsolete: false
  };
}

export function sanitizeDocument(document) {
  return {
    headerRaw: cleanString(document?.headerRaw, 24000),
    headers: Array.isArray(document?.headers)
      ? document.headers.slice(0, 48).map((header) => ({
          key: cleanString(header?.key, 200),
          value: cleanString(header?.value, 2000)
        }))
      : [],
    headerComments: {
      translator: cleanCommentList(document?.headerComments?.translator),
      extracted: cleanCommentList(document?.headerComments?.extracted),
      reference: cleanCommentList(document?.headerComments?.reference),
      flag: cleanCommentList(document?.headerComments?.flag),
      previous: cleanCommentList(document?.headerComments?.previous)
    },
    entries: Array.isArray(document?.entries) ? document.entries.slice(0, 6000).map(sanitizeEntry) : []
  };
}

function normalizeActiveLock(document, sessionId) {
  const now = Date.now();

  if (!document.lockOwnerId || !document.lockExpiresAt || document.lockExpiresAt < now) {
    return {
      holderId: null,
      holderName: null,
      expiresAt: null,
      ttlMs: LOCK_TTL_MS,
      isMine: false,
      isActive: false
    };
  }

  return {
    holderId: document.lockOwnerId,
    holderName: document.lockOwnerName || "Anonymous editor",
    expiresAt: document.lockExpiresAt,
    ttlMs: LOCK_TTL_MS,
    isMine: sessionId ? document.lockOwnerId === sessionId : false,
    isActive: true
  };
}

function shapeResponse(document, sessionId, storageMode) {
  return {
    ok: true,
    document: sanitizeDocument(document.content),
    meta: {
      id: document.id,
      name: document.name,
      version: document.version,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      storageMode
    },
    lock: normalizeActiveLock(document, sessionId)
  };
}

async function ensureSchema(db) {
  if (!globalThis[SCHEMA_READY_KEY]) {
    for (const statement of SCHEMA_STATEMENTS) {
      await db.prepare(statement).run();
    }

    for (const statement of SCHEMA_MIGRATIONS) {
      try {
        await db.prepare(statement).run();
      } catch (err) {
        if (!isIgnorableSchemaError(err)) {
          throw err;
        }
      }
    }

    globalThis[SCHEMA_READY_KEY] = true;
  }
}

function createId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function makeName(name) {
  const trimmed = cleanString(name, 120).trim();
  return trimmed || "Untitled translation";
}

function makeOwnerName(name) {
  const trimmed = cleanString(name, 80).trim();
  return trimmed || "Anonymous editor";
}

function normalizeDocumentPassword(password) {
  const trimmed = cleanString(password, 120).trim();
  return trimmed || DEFAULT_DOCUMENT_PASSWORD;
}

async function hashPassword(password) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function defaultPasswordHash() {
  if (!globalThis[DEFAULT_PASSWORD_HASH_KEY]) {
    globalThis[DEFAULT_PASSWORD_HASH_KEY] = hashPassword(DEFAULT_DOCUMENT_PASSWORD);
  }

  return globalThis[DEFAULT_PASSWORD_HASH_KEY];
}

async function makeStoredPasswordHash(password) {
  return hashPassword(normalizeDocumentPassword(password));
}

async function getResolvedPasswordHash(record) {
  return record.passwordHash || (await defaultPasswordHash());
}

async function assertDocumentPassword(record, password) {
  const provided = cleanString(password, 120).trim();

  if (!provided) {
    throw new DocumentPasswordError("Document password is required.");
  }

  const [expectedHash, providedHash] = await Promise.all([getResolvedPasswordHash(record), hashPassword(provided)]);

  if (expectedHash !== providedHash) {
    throw new DocumentPasswordError();
  }
}

function hydrateMemoryDocument(record) {
  const now = Date.now();

  if (record.lockOwnerId && record.lockExpiresAt && record.lockExpiresAt < now) {
    record.lockOwnerId = null;
    record.lockOwnerName = null;
    record.lockExpiresAt = null;
  }

  return record;
}

async function getD1Document(db, id) {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT id, name, content_json, password_hash, version, created_at, updated_at, lock_owner_id, lock_owner_name, lock_expires_at FROM documents WHERE id = ?"
    )
    .bind(id)
    .first();

  if (!row) {
    return null;
  }

  const now = Date.now();

  if (row.lock_expires_at && row.lock_expires_at < now) {
    await db
      .prepare(
        "UPDATE documents SET lock_owner_id = NULL, lock_owner_name = NULL, lock_expires_at = NULL WHERE id = ? AND lock_expires_at = ?"
      )
      .bind(id, row.lock_expires_at)
      .run();
    row.lock_owner_id = null;
    row.lock_owner_name = null;
    row.lock_expires_at = null;
  }

  return {
    id: row.id,
    name: row.name,
    content: JSON.parse(row.content_json),
    passwordHash: row.password_hash || null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lockOwnerId: row.lock_owner_id,
    lockOwnerName: row.lock_owner_name,
    lockExpiresAt: row.lock_expires_at
  };
}

async function loadStoredDocument(env, id) {
  const storageMode = getStorageMode(env);

  if (storageMode === "d1") {
    return {
      storageMode,
      record: await getD1Document(env.DB, id)
    };
  }

  const record = memoryStore().documents.get(id);

  return {
    storageMode,
    record: record ? hydrateMemoryDocument(record) : null
  };
}

function requireStorage(env) {
  if (env?.DB) {
    return "d1";
  }

  if (allowMemoryStore(env)) {
    return "memory";
  }

  throw new StorageConfigError("Persistent storage is not configured. Add a D1 binding named DB before using this deployment.");
}

export function getStorageMode(env) {
  return requireStorage(env);
}

export async function createDocument(env, payload) {
  const storageMode = getStorageMode(env);
  const content = sanitizeDocument(payload.document);
  const id = createId();
  const createdAt = nowIso();
  const lockExpiresAt = Date.now() + LOCK_TTL_MS;
  const passwordHash = await makeStoredPasswordHash(payload.password);
  const record = {
    id,
    name: makeName(payload.name),
    content,
    passwordHash,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    lockOwnerId: cleanString(payload.sessionId, 120) || createId(),
    lockOwnerName: makeOwnerName(payload.displayName),
    lockExpiresAt
  };

  if (storageMode === "d1") {
    await ensureSchema(env.DB);
    await env.DB
      .prepare(
        "INSERT INTO documents (id, name, content_json, password_hash, version, created_at, updated_at, lock_owner_id, lock_owner_name, lock_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        record.id,
        record.name,
        JSON.stringify(record.content),
        record.passwordHash,
        record.version,
        record.createdAt,
        record.updatedAt,
        record.lockOwnerId,
        record.lockOwnerName,
        record.lockExpiresAt
      )
      .run();

    return shapeResponse(record, record.lockOwnerId, "d1");
  }

  memoryStore().documents.set(record.id, record);
  return shapeResponse(record, record.lockOwnerId, "memory");
}

export async function getDocument(env, id, sessionId = "") {
  if (!id) {
    return null;
  }

  const { record, storageMode } = await loadStoredDocument(env, id);

  if (!record) {
    return null;
  }

  return shapeResponse(record, sessionId, storageMode);
}

export async function acquireLock(env, payload) {
  const id = cleanString(payload.id, 120);
  const sessionId = cleanString(payload.sessionId, 120);

  if (!id || !sessionId) {
    return null;
  }

  const storageMode = getStorageMode(env);
  const displayName = makeOwnerName(payload.displayName);
  const expiresAt = Date.now() + LOCK_TTL_MS;

  if (storageMode === "d1") {
    await ensureSchema(env.DB);
    await env.DB
      .prepare(
        "UPDATE documents SET lock_owner_id = NULL, lock_owner_name = NULL, lock_expires_at = NULL WHERE id = ? AND lock_expires_at IS NOT NULL AND lock_expires_at < ?"
      )
      .bind(id, Date.now())
      .run();
    await env.DB
      .prepare(
        "UPDATE documents SET lock_owner_id = ?, lock_owner_name = ?, lock_expires_at = ? WHERE id = ? AND (lock_owner_id IS NULL OR lock_expires_at IS NULL OR lock_expires_at < ? OR lock_owner_id = ?)"
      )
      .bind(sessionId, displayName, expiresAt, id, Date.now(), sessionId)
      .run();

    const record = await getD1Document(env.DB, id);
    return record ? shapeResponse(record, sessionId, "d1") : null;
  }

  const record = memoryStore().documents.get(id);

  if (!record) {
    return null;
  }

  hydrateMemoryDocument(record);

  if (!record.lockOwnerId || record.lockOwnerId === sessionId) {
    record.lockOwnerId = sessionId;
    record.lockOwnerName = displayName;
    record.lockExpiresAt = expiresAt;
  }

  return shapeResponse(record, sessionId, "memory");
}

export async function heartbeat(env, payload) {
  const id = cleanString(payload.id, 120);
  const sessionId = cleanString(payload.sessionId, 120);

  if (!id || !sessionId) {
    return null;
  }

  const storageMode = getStorageMode(env);
  const displayName = makeOwnerName(payload.displayName);
  const expiresAt = Date.now() + LOCK_TTL_MS;

  if (storageMode === "d1") {
    await ensureSchema(env.DB);
    await env.DB
      .prepare(
        "UPDATE documents SET lock_owner_name = ?, lock_expires_at = ? WHERE id = ? AND lock_owner_id = ? AND lock_expires_at >= ?"
      )
      .bind(displayName, expiresAt, id, sessionId, Date.now())
      .run();
    const record = await getD1Document(env.DB, id);
    return record ? shapeResponse(record, sessionId, "d1") : null;
  }

  const record = memoryStore().documents.get(id);

  if (!record) {
    return null;
  }

  hydrateMemoryDocument(record);

  if (record.lockOwnerId === sessionId) {
    record.lockOwnerName = displayName;
    record.lockExpiresAt = expiresAt;
  }

  return shapeResponse(record, sessionId, "memory");
}

export async function saveDocument(env, payload) {
  const id = cleanString(payload.id, 120);
  const sessionId = cleanString(payload.sessionId, 120);

  if (!id || !sessionId) {
    return null;
  }

  const storageMode = getStorageMode(env);
  const content = sanitizeDocument(payload.document);
  const displayName = makeOwnerName(payload.displayName);
  const updatedAt = nowIso();
  const expiresAt = Date.now() + LOCK_TTL_MS;
  const version = Number(payload.version || 0);
  const currentRecord = await loadStoredDocument(env, id);

  if (!currentRecord.record) {
    return null;
  }

  await assertDocumentPassword(currentRecord.record, payload.password);

  if (storageMode === "d1") {
    await ensureSchema(env.DB);
    await env.DB
      .prepare(
        "UPDATE documents SET content_json = ?, version = version + 1, updated_at = ?, lock_owner_name = ?, lock_expires_at = ? WHERE id = ? AND lock_owner_id = ? AND lock_expires_at >= ? AND version = ?"
      )
      .bind(JSON.stringify(content), updatedAt, displayName, expiresAt, id, sessionId, Date.now(), version)
      .run();
    const record = await getD1Document(env.DB, id);
    return record ? shapeResponse(record, sessionId, "d1") : null;
  }

  const record = memoryStore().documents.get(id);

  if (!record) {
    return null;
  }

  hydrateMemoryDocument(record);

  if (record.lockOwnerId === sessionId && record.version === version) {
    record.content = content;
    record.version += 1;
    record.updatedAt = updatedAt;
    record.lockOwnerName = displayName;
    record.lockExpiresAt = expiresAt;
  }

  return shapeResponse(record, sessionId, "memory");
}

export async function releaseLock(env, payload) {
  const id = cleanString(payload.id, 120);
  const sessionId = cleanString(payload.sessionId, 120);

  if (!id || !sessionId) {
    return null;
  }

  const storageMode = getStorageMode(env);

  if (storageMode === "d1") {
    await ensureSchema(env.DB);
    await env.DB
      .prepare(
        "UPDATE documents SET lock_owner_id = NULL, lock_owner_name = NULL, lock_expires_at = NULL WHERE id = ? AND lock_owner_id = ?"
      )
      .bind(id, sessionId)
      .run();
    const record = await getD1Document(env.DB, id);
    return record ? shapeResponse(record, sessionId, "d1") : null;
  }

  const record = memoryStore().documents.get(id);

  if (!record) {
    return null;
  }

  hydrateMemoryDocument(record);

  if (record.lockOwnerId === sessionId) {
    record.lockOwnerId = null;
    record.lockOwnerName = null;
    record.lockExpiresAt = null;
  }

  return shapeResponse(record, sessionId, "memory");
}

export async function deleteDocument(env, payload) {
  const id = cleanString(payload?.id, 120);

  if (!id) {
    return null;
  }

  const { record, storageMode } = await loadStoredDocument(env, id);

  if (!record) {
    return null;
  }

  await assertDocumentPassword(record, payload?.password);

  if (storageMode === "d1") {
    await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();

    return {
      ok: true,
      deletedId: id,
      deletedName: record.name,
      storageMode: "d1"
    };
  }

  memoryStore().documents.delete(id);

  return {
    ok: true,
    deletedId: id,
    deletedName: record.name,
    storageMode: "memory"
  };
}

export async function getProtectedDocument(env, payload) {
  const id = cleanString(payload?.id, 120);

  if (!id) {
    return null;
  }

  const { record, storageMode } = await loadStoredDocument(env, id);

  if (!record) {
    return null;
  }

  await assertDocumentPassword(record, payload?.password);

  return {
    id: record.id,
    name: record.name,
    document: sanitizeDocument(record.content),
    storageMode
  };
}
