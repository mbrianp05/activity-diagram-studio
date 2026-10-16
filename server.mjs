import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 5173);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    const filePath = join(root, normalize(pathname).replace(/^([/\\])+/, ""));
    if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: pathname + "/" }).end();
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type":
        mime[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("404 Not Found");
  }
});

server.listen(port, () => {
  console.log(`Activity Diagram Studio -> http://localhost:${port}`);
});
