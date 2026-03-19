import { saveDocument, StorageConfigError } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.sessionId || !body?.document) {
    return error("Missing save payload.");
  }

  try {
    const response = await saveDocument(context.env, body);
    return response ? json(response) : error("Document not found.", 404);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to save document.", 500, err instanceof Error ? err.message : String(err));
  }
}
