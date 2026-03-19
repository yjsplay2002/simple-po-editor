export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function error(message, status = 400, details = null) {
  return json(
    {
      ok: false,
      error: message,
      details
    },
    { status }
  );
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function getQueryParam(request, key) {
  return new URL(request.url).searchParams.get(key);
}
