// Minimal static server for the built Vite SPA. No dependencies.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const DIST = join(process.cwd(), "apps", "web", "dist");
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

async function send(res, path) {
  const data = await readFile(path);
  res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
  res.end(data);
}

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const safe = normalize(url).replace(/^(\.\.[/\\])+/, "");
    let path = join(DIST, safe);
    try {
      const s = await stat(path);
      if (s.isDirectory()) path = join(path, "index.html");
      await send(res, path);
    } catch {
      // SPA fallback
      await send(res, join(DIST, "index.html"));
    }
  } catch (e) {
    res.writeHead(500);
    res.end("server error");
  }
}).listen(PORT, () => console.log(`[web] serving ${DIST} on :${PORT}`));
