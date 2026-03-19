import { releaseLock } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.sessionId) {
    return error("Missing release payload.");
  }

  try {
    const response = await releaseLock(context.env, body);
    return response ? json(response) : error("Document not found.", 404);
  } catch (err) {
    return error("Failed to release lock.", 500, err instanceof Error ? err.message : String(err));
  }
}
