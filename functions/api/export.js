import { compilePo } from "../../po.js";
import { DocumentPasswordError, getProtectedDocument, StorageConfigError } from "../_lib/store.js";
import { error, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.id || !body?.password) {
    return error("Missing export payload.");
  }

  try {
    const response = await getProtectedDocument(context.env, body);

    if (!response) {
      return error("Document not found.", 404);
    }

    return new Response(compilePo(response.document), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  } catch (err) {
    if (err instanceof DocumentPasswordError) {
      return error(err.message, 403);
    }

    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to export document.", 500, err instanceof Error ? err.message : String(err));
  }
}
