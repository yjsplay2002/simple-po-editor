import { listDocuments, StorageConfigError } from "../_lib/store.js";
import { error, json, getQueryParam } from "../_lib/http.js";

export async function onRequestGet(context) {
  const sessionId = getQueryParam(context.request, "sessionId") || "";
  const limit = getQueryParam(context.request, "limit") || "24";

  try {
    const response = await listDocuments(context.env, sessionId, { limit });
    return json(response);
  } catch (err) {
    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to load shared documents.", 500, err instanceof Error ? err.message : String(err));
  }
}
