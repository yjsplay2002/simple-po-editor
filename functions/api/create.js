import { createDocument } from "../_lib/store.js";
import { error, json, readJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);

  if (!body?.document) {
    return error("Missing document payload.");
  }

  try {
    const response = await createDocument(context.env, body);
    return json(response, { status: 201 });
  } catch (err) {
    return error("Failed to create document.", 500, err instanceof Error ? err.message : String(err));
  }
}
