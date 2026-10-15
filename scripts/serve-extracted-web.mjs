import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const requestedRoot = process.env.NEARLINK_EXTRACTED_WEB_DIR;
if (!requestedRoot) throw new Error("NEARLINK_EXTRACTED_WEB_DIR must point to an extracted web package.");
const root = await realpath(requestedRoot);
const port = Number(process.env.NEARLINK_PACKAGE_PORT ?? "4174");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);
let originAvailable = true;

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "POST" && pathname === "/__test__/origin-unavailable") {
    originAvailable = false;
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && pathname === "/__test__/origin-available") {
    originAvailable = true;
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (!originAvailable) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Package origin unavailable");
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const resolved = await realpath(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("outside root");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Length": info.size,
      "Content-Type": mimeTypes.get(path.extname(resolved)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(resolved).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving extracted NearLink package at http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
