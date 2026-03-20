import test from "node:test";
import assert from "node:assert/strict";
import {
  createDocument,
  deleteDocument,
  DocumentPasswordError,
  getDocument,
  listDocuments,
  saveEntry,
  StorageConfigError
} from "../functions/_lib/store.js";

function makeDocumentPayload() {
  return {
    displayName: "Tester",
    name: "demo",
    sessionId: "session-1",
    document: {
      headerRaw: "Project-Id-Version: demo\nLanguage: en\n",
      headers: [
        { key: "Project-Id-Version", value: "demo" },
        { key: "Language", value: "en" }
      ],
      headerComments: {
        translator: [],
        extracted: [],
        reference: [],
        flag: [],
        previous: []
      },
      entries: [
        {
          id: "entry-1",
          msgctxt: "",
          msgid: "Hello",
          msgidPlural: "",
          msgstr: [""],
          comments: {
            translator: [],
            extracted: [],
            reference: [],
            flag: [],
            previous: []
          }
        }
      ]
    }
  };
}

test("memory mode is allowed for the local dev server flag", async () => {
  const created = await createDocument({ ALLOW_MEMORY_STORE: true }, makeDocumentPayload());
  const loaded = await getDocument({ ALLOW_MEMORY_STORE: true }, created.meta.id, "session-1");

  assert.equal(created.meta.storageMode, "memory");
  assert.equal(loaded?.document.entries[0].msgid, "Hello");
});

test("production-like env without D1 fails fast", async () => {
  await assert.rejects(() => createDocument({}, makeDocumentPayload()), StorageConfigError);
});

test("deleteDocument removes a memory document when the password is correct", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const created = await createDocument(env, makeDocumentPayload());
  const deleted = await deleteDocument(env, {
    id: created.meta.id,
    password: "3757"
  });
  const loaded = await getDocument(env, created.meta.id, "session-1");

  assert.equal(deleted?.deletedId, created.meta.id);
  assert.equal(loaded, null);
});

test("deleteDocument uses the uploaded custom password when one is provided", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const created = await createDocument(env, {
    ...makeDocumentPayload(),
    password: "9988"
  });

  await assert.rejects(
    () =>
      deleteDocument(env, {
        id: created.meta.id,
        password: "3757"
      }),
    DocumentPasswordError
  );

  const deleted = await deleteDocument(env, {
    id: created.meta.id,
    password: "9988"
  });

  assert.equal(deleted?.deletedId, created.meta.id);
});

test("legacy documents without a stored password fall back to 3757", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const memoryKey = Symbol.for("simple-po-editor.memory");
  const legacyId = "legacy-doc";

  globalThis[memoryKey] = {
    documents: new Map([
      [
        legacyId,
        {
          id: legacyId,
          name: "legacy",
          content: makeDocumentPayload().document,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lockOwnerId: null,
          lockOwnerName: null,
          lockExpiresAt: null
        }
      ]
    ])
  };

  const deleted = await deleteDocument(env, {
    id: legacyId,
    password: "3757"
  });

  assert.equal(deleted?.deletedId, legacyId);
});

test("getDocument can return a recent-list summary without the document body", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const created = await createDocument(env, makeDocumentPayload());
  const summary = await getDocument(env, created.meta.id, "session-2", {
    includeDocument: false
  });

  assert.equal(summary?.document, undefined);
  assert.equal(summary?.meta.id, created.meta.id);
  assert.equal(summary?.lock.isActive, true);
  assert.equal(summary?.lock.isMine, false);
});

test("listDocuments returns shared summaries in updated order", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const memoryKey = Symbol.for("simple-po-editor.memory");

  globalThis[memoryKey] = {
    documents: new Map()
  };

  const first = await createDocument(env, {
    ...makeDocumentPayload(),
    name: "first"
  });
  const second = await createDocument(env, {
    ...makeDocumentPayload(),
    name: "second",
    sessionId: "session-2"
  });
  const documents = globalThis[memoryKey].documents;

  documents.get(first.meta.id).updatedAt = "2026-03-01T00:00:00.000Z";
  documents.get(second.meta.id).updatedAt = "2026-03-02T00:00:00.000Z";

  const listed = await listDocuments(env, "session-3", { limit: 10 });

  assert.deepEqual(
    listed.documents.map((item) => item.meta.name),
    ["second", "first"]
  );
  assert.equal(listed.documents[0].lock.isActive, true);
  assert.equal(listed.documents[0].lock.isMine, false);
  assert.equal(listed.documents[0].document, undefined);
});

test("saveEntry updates one row without replacing sibling rows", async () => {
  const env = { ALLOW_MEMORY_STORE: true };
  const created = await createDocument(env, {
    ...makeDocumentPayload(),
    document: {
      ...makeDocumentPayload().document,
      entries: [
        makeDocumentPayload().document.entries[0],
        {
          ...makeDocumentPayload().document.entries[0],
          id: "entry-2",
          msgid: "Goodbye"
        }
      ]
    }
  });

  const response = await saveEntry(env, {
    id: created.meta.id,
    entryId: "entry-1",
    msgstr: ["안녕"],
    password: "3757",
    displayName: "Mina"
  });
  const loaded = await getDocument(env, created.meta.id, "session-1");

  assert.equal(response?.meta.version, 2);
  assert.equal(response?.entry.msgstr[0], "안녕");
  assert.equal(response?.entry.revision, 1);
  assert.equal(response?.entry.lastEditorName, "Mina");
  assert.equal(loaded?.document.entries[0].msgstr[0], "안녕");
  assert.equal(loaded?.document.entries[1].msgstr[0], "");
});
