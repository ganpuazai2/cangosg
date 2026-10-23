// Local preview without the Vercel CLI: serves public/ and runs api/*.js like Vercel would.
// Usage: node scripts/local-server.mjs   (reads keys from .env)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try { process.loadEnvFile(join(root, ".env")); } catch {}
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
};

function wrap(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  return res;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const api = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const mod = await import(pathToFileURL(join(root, "api", `${api[1]}.js`)).href);
      req.query = Object.fromEntries(url.searchParams);
      return await mod.default(req, wrap(res));
    }
    let file = normalize(join(root, "public", decodeURIComponent(url.pathname)));
    if (!file.startsWith(join(root, "public"))) throw new Error("bad path");
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch (e) {
    if (!res.headersSent) res.statusCode = e.code === "ENOENT" || e.code === "ERR_MODULE_NOT_FOUND" ? 404 : 500;
    res.end(String(e.message));
  }
}).listen(PORT, () => console.log(`CanGo SG running at http://localhost:${PORT}`));
