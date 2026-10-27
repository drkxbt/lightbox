// A zero-dependency static server for the demo: `npm run demo`, then open http://localhost:4324/demo/.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 4324);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // The demo links its files relative to /demo/, so the root has to redirect rather than serve the page in place.
  if (url.pathname === "/" || url.pathname === "/demo") {
    response.writeHead(302, { location: "/demo/" }).end();
    return;
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  // Only files inside the repo are served.
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`lightbox demo: http://localhost:${PORT}/demo/`));
