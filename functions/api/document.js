import { getDocument, StorageConfigError } from "../_lib/store.js";
import { error, json, getQueryParam } from "../_lib/http.js";

export async function onRequestGet(context) {
  const id = getQueryParam(context.request, "id");
  const sessionId = getQueryParam(context.request, "sessionId") || "";
  const includeDocument = getQueryParam(context.request, "summary") !== "1";

  if (!id) {
    return error("Missing document id.");
  }

  try {
    const response = await getDocument(context.env, id, sessionId, { includeDocument });
    return response ? json(response) : error("Document not found.", 404);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to load document.", 500, err instanceof Error ? err.message : String(err));
  }
}
