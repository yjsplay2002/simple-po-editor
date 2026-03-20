import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, deleteDocument, DocumentPasswordError, getDocument, StorageConfigError } from "../functions/_lib/store.js";

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
