function createEmptyComments() {
  return {
    translator: [],
    extracted: [],
    reference: [],
    flag: [],
    previous: []
  };
}

function createEmptyEntry() {
  return {
    id: "",
    msgctxt: "",
    msgid: "",
    msgidPlural: "",
    msgstr: [""],
    comments: createEmptyComments(),
    obsolete: false
  };
}

function hasContent(entry) {
  return Boolean(
    entry.msgid ||
      entry.msgctxt ||
      entry.msgidPlural ||
      entry.msgstr.some((value) => value) ||
      entry.comments.translator.length ||
      entry.comments.extracted.length ||
      entry.comments.reference.length ||
      entry.comments.flag.length ||
      entry.comments.previous.length
  );
}

function safeParseQuoted(source) {
  try {
    return JSON.parse(source);
  } catch {
    return source.slice(1, -1);
  }
}

function setField(entry, target, value, index = 0) {
  if (target === "msgstr") {
    while (entry.msgstr.length <= index) {
      entry.msgstr.push("");
    }
    entry.msgstr[index] = value;
    return;
  }

  entry[target] = value;
}

function appendField(entry, activeField, value) {
  if (!activeField) {
    return;
  }

  if (activeField.target === "msgstr") {
    entry.msgstr[activeField.index] += value;
    return;
  }

  entry[activeField.target] += value;
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeEntryId(entry, index) {
  return `entry-${index + 1}-${hashString(`${entry.msgctxt}\u0004${entry.msgid}`)}`;
}

function normalizeCommentList(list) {
  return Array.isArray(list)
    ? list
        .map((value) => (typeof value === "string" ? value.trimEnd() : ""))
        .filter(Boolean)
    : [];
}

export function getEntryStatus(entry) {
  const hasTranslatedText = entry.msgstr.some((value) => value.trim() !== "");
  const isFuzzy = entry.comments.flag.some((flag) => flag.split(",").map((part) => part.trim()).includes("fuzzy"));

  if (isFuzzy) {
    return "fuzzy";
  }

  return hasTranslatedText ? "translated" : "untranslated";
}

export function summarizeEntries(entries) {
  return entries.reduce(
    (summary, entry) => {
      const status = getEntryStatus(entry);
      summary.total += 1;
      summary[status] += 1;
      return summary;
    },
    { total: 0, translated: 0, untranslated: 0, fuzzy: 0 }
  );
}

export function parseHeaderRaw(headerRaw) {
  return String(headerRaw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        return { key: "", value: line };
      }

      return {
        key: line.slice(0, separatorIndex).trim(),
        value: line.slice(separatorIndex + 1).trim()
      };
    });
}

function buildHeaderRaw(headers) {
  const safeHeaders = Array.isArray(headers) ? headers : [];

  if (safeHeaders.length === 0) {
    return [
      "Project-Id-Version: simple-po-editor",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "Language: "
    ].join("\n") + "\n";
  }

  return (
    safeHeaders
      .map(({ key, value }) => {
        if (!key) {
          return String(value || "").trim();
        }

        return `${String(key).trim()}: ${String(value || "").trim()}`;
      })
      .join("\n") + "\n"
  );
}

function splitPoSegments(value) {
  if (value === "") {
    return [""];
  }

  const parts = value.split("\n");
  const segments = [];

  for (let index = 0; index < parts.length; index += 1) {
    const suffix = index < parts.length - 1 ? "\n" : "";
    segments.push(parts[index] + suffix);
  }

  return segments;
}

function formatPoField(keyword, value) {
  const safeValue = String(value ?? "");
  const segments = splitPoSegments(safeValue);

  if (segments.length === 1 && !safeValue.includes("\n") && safeValue.length < 84) {
    return [`${keyword} ${JSON.stringify(safeValue)}`];
  }

  return [`${keyword} ""`, ...segments.map((segment) => JSON.stringify(segment))];
}

function serializeComments(entry) {
  const lines = [];

  for (const comment of normalizeCommentList(entry.comments.translator)) {
    lines.push(comment ? `# ${comment}` : "#");
  }

  for (const comment of normalizeCommentList(entry.comments.extracted)) {
    lines.push(`#. ${comment}`);
  }

  for (const comment of normalizeCommentList(entry.comments.reference)) {
    lines.push(`#: ${comment}`);
  }

  for (const comment of normalizeCommentList(entry.comments.flag)) {
    lines.push(`#, ${comment}`);
  }

  for (const comment of normalizeCommentList(entry.comments.previous)) {
    lines.push(`#| ${comment}`);
  }

  return lines;
}

function serializeEntry(entry) {
  const lines = [...serializeComments(entry)];

  if (entry.msgctxt) {
    lines.push(...formatPoField("msgctxt", entry.msgctxt));
  }

  lines.push(...formatPoField("msgid", entry.msgid));

  if (entry.msgidPlural) {
    lines.push(...formatPoField("msgid_plural", entry.msgidPlural));
  }

  const translations = Array.isArray(entry.msgstr) && entry.msgstr.length > 0 ? entry.msgstr : [""];

  if (entry.msgidPlural || translations.length > 1) {
    translations.forEach((value, index) => {
      lines.push(...formatPoField(`msgstr[${index}]`, value));
    });
  } else {
    lines.push(...formatPoField("msgstr", translations[0] ?? ""));
  }

  if (entry.obsolete) {
    return lines.map((line) => `#~ ${line}`);
  }

  return lines;
}

export function parsePo(source) {
  const text = String(source || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const parsedEntries = [];
  let current = createEmptyEntry();
  let activeField = null;

  const flush = () => {
    if (!hasContent(current)) {
      current = createEmptyEntry();
      activeField = null;
      return;
    }

    parsedEntries.push(current);
    current = createEmptyEntry();
    activeField = null;
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === "") {
      flush();
      continue;
    }

    let line = rawLine;

    if (line.startsWith("#~")) {
      current.obsolete = true;
      line = line.slice(2).trimStart();
    }

    if (line.startsWith("#.")) {
      current.comments.extracted.push(line.slice(2).trimStart());
      activeField = null;
      continue;
    }

    if (line.startsWith("#:")) {
      current.comments.reference.push(line.slice(2).trimStart());
      activeField = null;
      continue;
    }

    if (line.startsWith("#,")) {
      current.comments.flag.push(line.slice(2).trimStart());
      activeField = null;
      continue;
    }

    if (line.startsWith("#|")) {
      current.comments.previous.push(line.slice(2).trimStart());
      activeField = null;
      continue;
    }

    if (line === "#" || line.startsWith("# ")) {
      current.comments.translator.push(line === "#" ? "" : line.slice(2));
      activeField = null;
      continue;
    }

    const fieldMatch = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/);

    if (fieldMatch) {
      const keyword = fieldMatch[1];
      const pluralIndex = fieldMatch[2] ? Number(fieldMatch[2]) : 0;
      const value = safeParseQuoted(fieldMatch[3]);

      if (keyword.startsWith("msgstr")) {
        activeField = { target: "msgstr", index: pluralIndex };
      } else if (keyword === "msgid_plural") {
        activeField = { target: "msgidPlural", index: 0 };
      } else {
        activeField = { target: keyword, index: 0 };
      }

      setField(current, activeField.target, value, activeField.index);
      continue;
    }

    if (line.startsWith("\"")) {
      appendField(current, activeField, safeParseQuoted(line));
    }
  }

  flush();

  let headerRaw = "";
  let headers = [];
  let headerComments = createEmptyComments();
  let activeEntries = parsedEntries;

  if (parsedEntries[0] && parsedEntries[0].msgid === "") {
    const headerEntry = parsedEntries[0];
    headerRaw = headerEntry.msgstr[0] ?? "";
    headers = parseHeaderRaw(headerRaw);
    headerComments = headerEntry.comments;
    activeEntries = parsedEntries.slice(1);
  }

  const entries = activeEntries
    .filter((entry) => !entry.obsolete)
    .map((entry, index) => ({
      ...entry,
      id: entry.id || makeEntryId(entry, index),
      comments: {
        translator: normalizeCommentList(entry.comments.translator),
        extracted: normalizeCommentList(entry.comments.extracted),
        reference: normalizeCommentList(entry.comments.reference),
        flag: normalizeCommentList(entry.comments.flag),
        previous: normalizeCommentList(entry.comments.previous)
      },
      msgstr: Array.isArray(entry.msgstr) && entry.msgstr.length > 0 ? entry.msgstr : [""]
    }));

  return {
    headerRaw,
    headers,
    headerComments,
    entries,
    summary: summarizeEntries(entries)
  };
}

export function compilePo(document) {
  const headerRaw = document?.headerRaw ? String(document.headerRaw) : buildHeaderRaw(document?.headers);
  const headerEntry = {
    ...createEmptyEntry(),
    msgid: "",
    msgstr: [headerRaw],
    comments: document?.headerComments || createEmptyComments()
  };
  const safeEntries = Array.isArray(document?.entries) ? document.entries : [];
  const blocks = [serializeEntry(headerEntry), ...safeEntries.map((entry) => serializeEntry(entry))];

  return blocks.map((block) => block.join("\n")).join("\n\n").trimEnd() + "\n";
}
