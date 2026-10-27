import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadDirectFile } from "../media-download.js";

test("direct downloads reject access pages and empty media, enforce stream limits, and clean partial files", async (t) => {
  const media = Buffer.from("\x00\x00\x00\x18ftypmp42-test-media");
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/video" }).end();
    } else if (request.url === "/html") {
      response.writeHead(200, { "Content-Type": "text/html" }).end("<html>Access denied</html>");
    } else if (request.url === "/hidden-html") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end("<!DOCTYPE html>Blocked");
    } else if (request.url === "/empty") {
      response.writeHead(200, { "Content-Type": "video/mp4" }).end();
    } else if (request.url === "/oversized") {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": media.length }).end(media);
    } else {
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(media.subarray(0, 10));
      response.end(media.subarray(10));
    }
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-download-test-"));
  const output = path.join(directory, "video.mp4");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/html", "/hidden-html", "/empty"]) {
    await assert.rejects(downloadDirectFile(`${base}${route}`, output), /web page|empty video/);
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
  for (const route of ["/oversized", "/video"]) {
    await assert.rejects(downloadDirectFile(`${base}${route}`, output, {}, { maxBytes: 12 }), { code: "MEDIA_TOO_LARGE" });
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
  await downloadDirectFile(`${base}/redirect`, output);
  assert.deepEqual(await fs.readFile(output), media);
});
