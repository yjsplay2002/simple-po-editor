import { deleteDocument, DocumentPasswordError, StorageConfigError } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.password) {
    return error("Missing delete payload.");
  }

  try {
    const response = await deleteDocument(context.env, body);
    return response ? json(response) : error("Document not found.", 404);
  } catch (err) {
    if (err instanceof DocumentPasswordError) {
      return error(err.message, 403);
    }

    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to delete document.", 500, err instanceof Error ? err.message : String(err));
  }
}
