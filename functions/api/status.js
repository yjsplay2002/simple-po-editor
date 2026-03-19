import { getStorageMode, StorageConfigError } from "../_lib/store.js";
import { error, json } from "../_lib/http.js";

export async function onRequestGet(context) {
  try {
    return json({
      ok: true,
      storageMode: getStorageMode(context.env)
    });
  } catch (err) {
    if (err instanceof StorageConfigError) {
      return error(err.message, 503);
    }

    return error("Failed to inspect storage mode.", 500, err instanceof Error ? err.message : String(err));
  }
}
