// The production server: static client assets, the frames endpoint (the
// generated server functions at `/_server/<id>`), and the document render.
// Compressed like ../hackernews/server.js (brotli 4 streamed, 9 for static
// assets) so the two apps are measured through the same kind of origin.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { brotliCompressSync, createBrotliCompress, createGzip, constants } from "node:zlib";
import { render, handleServerFunctionRequest } from "./dist/server/entry-server.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3006;
const template = readFileSync(path.join(root, "dist/client/index.html"), "utf8");

const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

function encoder(req, res) {
  const accepts = req.headers["accept-encoding"] || "";
  let stream;
  if (/\bbr\b/.test(accepts)) {
    res.setHeader("Content-Encoding", "br");
    stream = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  } else if (/\bgzip\b/.test(accepts)) {
    res.setHeader("Content-Encoding", "gzip");
    stream = createGzip();
  } else return null;
  stream.pipe(res);
  return stream;
}

const staticBrotli = new Map();

function webRequest(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);
  const method = req.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req);
  return new Request(url, {
    method,
    headers: req.headers,
    body,
    ...(body ? { duplex: "half" } : {})
  });
}

async function send(req, res, response) {
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.statusCode = response.status;
  const out = encoder(req, res) ?? res;
  if (response.body) for await (const chunk of response.body) out.write(chunk);
  out.end();
}

createServer(async (req, res) => {
  const url = req.url || "/";
  if (url !== "/" && !url.includes("..") && !url.startsWith("/_server")) {
    const file = url.split("?")[0];
    try {
      const content = readFileSync(path.resolve(root, "dist/client" + file));
      const headers = {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600"
      };
      if (/\bbr\b/.test(req.headers["accept-encoding"] || "")) {
        let c = staticBrotli.get(file);
        if (!c)
          staticBrotli.set(
            file,
            (c = brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }))
          );
        res.writeHead(200, { ...headers, "Content-Encoding": "br" });
        return res.end(c);
      }
      res.writeHead(200, headers);
      return res.end(content);
    } catch {
      // Fall through: a route.
    }
  }
  try {
    if (url.startsWith("/_server"))
      return await send(req, res, await handleServerFunctionRequest(webRequest(req)));
    const t = performance.now();
    const html = template.replace("<!--app-->", await render(url));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Server-Timing", `render;dur=${(performance.now() - t).toFixed(2)}`);
    const out = encoder(req, res) ?? res;
    out.end(html);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(String(e && e.message));
  }
}).listen(PORT, () => {
  console.log(`HackerNews (compiler-derived server components) on http://localhost:${PORT}`);
});
