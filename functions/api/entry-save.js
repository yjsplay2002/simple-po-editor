import { DocumentPasswordError, saveEntry, StorageConfigError } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.entryId || !Array.isArray(body?.msgstr)) {
    return error("Missing row save payload.");
  }

  try {
    const response = await saveEntry(context.env, body);
    return response ? json(response) : error("Entry not found.", 404);
  } catch (err) {
    if (err instanceof DocumentPasswordError) {
      return error(err.message, 403);
    }

    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to save row.", 500, err instanceof Error ? err.message : String(err));
  }
}
