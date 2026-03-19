import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);

const apiModules = {
  "/api/create": "./functions/api/create.js",
  "/api/document": "./functions/api/document.js",
  "/api/lock": "./functions/api/lock.js",
  "/api/heartbeat": "./functions/api/heartbeat.js",
  "/api/save": "./functions/api/save.js",
  "/api/release": "./functions/api/release.js"
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendNodeResponse(nodeResponse, response) {
  nodeResponse.statusCode = response.status;

  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  response.arrayBuffer().then((body) => {
    nodeResponse.end(Buffer.from(body));
  });
}

async function readBody(nodeRequest) {
  const chunks = [];

  for await (const chunk of nodeRequest) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

async function handleApi(nodeRequest, nodeResponse, pathname) {
  const modulePath = apiModules[pathname];

  if (!modulePath) {
    nodeResponse.statusCode = 404;
    nodeResponse.end("Not found");
    return;
  }

  const imported = await import(pathToFileURL(path.resolve(rootDir, modulePath)).href);
  const handlerName = `onRequest${nodeRequest.method[0]}${nodeRequest.method.slice(1).toLowerCase()}`;
  const handler = imported[handlerName];

  if (!handler) {
    nodeResponse.statusCode = 405;
    nodeResponse.end("Method not allowed");
    return;
  }

  const body = ["GET", "HEAD"].includes(nodeRequest.method) ? null : await readBody(nodeRequest);
  const requestUrl = new URL(nodeRequest.url, `http://localhost:${port}`);
  const headers = new Headers();

  Object.entries(nodeRequest.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  });

  const request = new Request(requestUrl, {
    method: nodeRequest.method,
    headers,
    body: body ? body.toString("utf8") : undefined
  });

  const response = await handler({
    env: {},
    request
  });

  sendNodeResponse(nodeResponse, response);
}

function resolveStaticPath(pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(rootDir, `.${normalized}`);

  if (!filePath.startsWith(rootDir)) {
    return null;
  }

  return filePath;
}

async function handleStatic(nodeResponse, pathname) {
  let targetPath = resolveStaticPath(pathname);

  try {
    if (!targetPath) {
      throw new Error("Invalid path");
    }

    const fileStat = await stat(targetPath);

    if (fileStat.isDirectory()) {
      targetPath = path.join(targetPath, "index.html");
    }
  } catch {
    targetPath = path.resolve(rootDir, "index.html");
  }

  try {
    const fileBuffer = await readFile(targetPath);
    const extension = path.extname(targetPath);
    nodeResponse.statusCode = 200;
    nodeResponse.setHeader("content-type", mimeTypes[extension] || "application/octet-stream");
    nodeResponse.end(fileBuffer);
  } catch {
    nodeResponse.statusCode = 404;
    nodeResponse.end("Not found");
  }
}

const server = http.createServer(async (nodeRequest, nodeResponse) => {
  const pathname = new URL(nodeRequest.url, `http://localhost:${port}`).pathname;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(nodeRequest, nodeResponse, pathname);
      return;
    }

    await handleStatic(nodeResponse, pathname);
  } catch (err) {
    nodeResponse.statusCode = 500;
    nodeResponse.setHeader("content-type", "application/json; charset=utf-8");
    nodeResponse.end(
      JSON.stringify({
        ok: false,
        error: "Local dev server crashed.",
        details: err instanceof Error ? err.message : String(err)
      })
    );
  }
});

server.listen(port, () => {
  console.log(`Simple PO Editor running at http://localhost:${port}`);
});
