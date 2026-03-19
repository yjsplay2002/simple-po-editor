import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, getDocument, StorageConfigError } from "../functions/_lib/store.js";

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
