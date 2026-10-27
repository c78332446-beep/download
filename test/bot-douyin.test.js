import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import axios from "axios";

process.env.BOT_TOKEN = "123456789:offline_test_token";
process.env.AUTO_DOWNLOAD = "true";
const { bot, getFriendlyErrorMessage, processIncomingUrl } = await import("../index.js");
await fs.mkdir(new URL("../downloads/", import.meta.url), { recursive: true });
const id = "7681979274496183552";
const inputUrl = "https://v.douyin.com/offlineTest/";
const pageUrl = `https://www.douyin.com/video/${id}`;
const media = Buffer.from("\x00\x00\x00\x18ftypmp42-offline-video");

function page(directUrl, alternateUrls = []) {
  return `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
    "video_(id)/page": { videoInfoRes: { item_list: [{
      aweme_id: id,
      video: { width: 1080, height: 1920, play_addr: { url_list: [directUrl, ...alternateUrls] } },
    }] } },
  } })};</script>`;
}

for (const scenario of ["metadata fails", "yt-dlp download fails", "direct URL expires", "CDN backup succeeds"]) {
  test(`AUTO_DOWNLOAD sends the video when ${scenario}`, async (t) => {
    assert.equal(bot.isPolling(), false);
    const messages = [];
    const uploads = [];
    const requests = [];
    let pageFetches = 0;
    const previousAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      requests.push(`${config.method.toUpperCase()} ${config.url}`);
      let data;
      let headers = { "content-type": "text/html" };
      if (config.url === inputUrl) {
        data = config.responseType === "stream" ? Readable.from(["resolved"]) : "<html>Resolved</html>";
      } else if (config.url.startsWith("https://media.example/") || config.url.startsWith("https://backup.example/")) {
        const expired = config.url.endsWith("expired.mp4");
        data = Readable.from([expired ? Buffer.from("<html>Access check</html>") : media]);
        headers = { "content-type": expired ? "text/html" : "video/mp4" };
      } else {
        pageFetches += 1;
        const expires = scenario === "direct URL expires" && pageFetches === 1 || scenario === "CDN backup succeeds";
        data = page(expires ? "https://media.example/expired.mp4" : "https://media.example/fresh.mp4",
          scenario === "CDN backup succeeds" ? ["https://backup.example/fresh.mp4"] : []);
      }
      return { data, status: 200, statusText: "OK", headers, config, request: { res: { responseUrl: config.url === inputUrl ? pageUrl : config.url } } };
    };
    t.after(() => { axios.defaults.adapter = previousAdapter; });
    t.mock.method(childProcess, "spawn", (binary, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        if (scenario === "yt-dlp download fails" && args.includes("--dump-single-json")) {
          child.stdout.end(JSON.stringify({ formats: [{ format_id: "hd", width: 1080, height: 1920, vcodec: "h264", acodec: "aac", ext: "mp4" }] }));
          child.emit("close", 0);
        } else {
          child.stderr.end("ERROR: HTTP Error 429: Too Many Requests");
          child.emit("close", 1);
        }
      });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    t.mock.method(bot, "sendMessage", async (chatId, text) => {
      messages.push(text);
      return { message_id: messages.length };
    });
    t.mock.method(bot, "sendChatAction", async () => true);
    t.mock.method(bot, "deleteMessage", async () => true);
    t.mock.method(bot, "sendVideo", async (chatId, filePath, options) => {
      uploads.push({ data: await fs.readFile(filePath), filePath, options });
      return { message_id: 999 };
    });
    t.mock.method(bot, "sendDocument", async () => assert.fail("video upload should succeed"));
    await processIncomingUrl(42, inputUrl, `5.30 share ${inputUrl}`);
    assert.equal(uploads.length, 1, messages.join("\n"));
    assert.deepEqual(uploads[0].data, media);
    assert.equal(uploads[0].options.supports_streaming, true);
    assert.equal(messages.some((message) => /Failed|did not provide|access-check/.test(message)), false);
    assert.equal(requests[0], `GET ${inputUrl}`);
    assert.equal(pageFetches, scenario === "direct URL expires" ? 2 : 1);
    if (scenario === "CDN backup succeeds") assert.equal(requests.some((request) => request.includes("backup.example")), true);
    await assert.rejects(fs.stat(uploads[0].filePath), { code: "ENOENT" });
  });
}

test("Douyin blocked and expired-link errors are specific instead of generic", () => {
  assert.match(getFriendlyErrorMessage("Douyin did not provide a public video stream."), /browser session/);
  assert.match(getFriendlyErrorMessage("Douyin share link did not resolve to a video."), /fresh video share link/);
  assert.match(getFriendlyErrorMessage("Douyin post is photo-only and has no downloadable video."), /photos/);
});
