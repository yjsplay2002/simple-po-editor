import test from "node:test";
import assert from "node:assert/strict";
import { compilePo, parsePo, summarizeEntries } from "../po.js";

const sample = `msgid ""
msgstr ""
"Project-Id-Version: sample\\n"
"Language: ko\\n"

#. Login title
#: src/login.ts:4
msgid "Sign in"
msgstr "로그인"

#, fuzzy
msgctxt "email"
msgid "Email"
msgstr "이메일"

msgid "File"
msgid_plural "Files"
msgstr[0] "파일"
msgstr[1] "파일들"
`;

test("parsePo reads headers, comments, and plural values", () => {
  const document = parsePo(sample);

  assert.equal(document.headers[1].key, "Language");
  assert.equal(document.entries.length, 3);
  assert.equal(document.entries[0].comments.extracted[0], "Login title");
  assert.equal(document.entries[2].msgstr[1], "파일들");
});

test("compilePo round-trips essential translation content", () => {
  const document = parsePo(sample);
  const output = compilePo(document);
  const reparsed = parsePo(output);

  assert.deepEqual(
    reparsed.entries.map((entry) => ({
      msgctxt: entry.msgctxt,
      msgid: entry.msgid,
      msgidPlural: entry.msgidPlural,
      msgstr: entry.msgstr,
      flags: entry.comments.flag
    })),
    document.entries.map((entry) => ({
      msgctxt: entry.msgctxt,
      msgid: entry.msgid,
      msgidPlural: entry.msgidPlural,
      msgstr: entry.msgstr,
      flags: entry.comments.flag
    }))
  );
});

test("summarizeEntries counts translated, fuzzy, and untranslated rows", () => {
  const summary = summarizeEntries([
    { msgstr: [""], comments: { flag: [] } },
    { msgstr: ["Done"], comments: { flag: [] } },
    { msgstr: ["Almost"], comments: { flag: ["fuzzy"] } }
  ]);

  assert.deepEqual(summary, {
    total: 3,
    translated: 1,
    untranslated: 1,
    fuzzy: 1
  });
});
