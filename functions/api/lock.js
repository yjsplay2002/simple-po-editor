import { acquireLock, StorageConfigError } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.sessionId) {
    return error("Missing lock payload.");
  }

  try {
    const response = await acquireLock(context.env, body);
    return response ? json(response) : error("Document not found.", 404);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to acquire lock.", 500, err instanceof Error ? err.message : String(err));
  }
}
