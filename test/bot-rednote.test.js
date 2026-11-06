import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import axios from "axios";

process.env.BOT_TOKEN = "123456789:offline_rednote_test";
process.env.AUTO_DOWNLOAD = "true";
const { bot, handleSelectionDownload, processIncomingUrl } = await import("../index.js");
await fs.mkdir(new URL("../downloads/", import.meta.url), { recursive: true });

const noteId = "6aec3d98000000000303a076";
const inputUrl = "http://xhslink.com/o/offlineTest";
const pageUrl = `https://www.rednote.com/discovery/item/${noteId}?xsec_token=test`;
const originalUrl = "https://sns-video-bd.xhscdn.com/pre_post/original";
const playbackUrl = "https://media.example/playback.mp4";
const freshUrl = "https://media.example/fresh.mp4";
const backupUrl = "https://backup.example/playback.mp4";
const videoBytes = Buffer.from("\x00\x00\x00\x18ftypmp42-offline-rednote-video");

function videoPage(url = playbackUrl, backupUrls = [], includeOriginal = true) {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
    [noteId]: { note: { noteId, type: "video", video: {
      ...(includeOriginal ? { consumer: { originVideoKey: "pre_post/original" } } : {}),
      media: { stream: { h264: [{ width: 720, height: 1280, masterUrl: url, backupUrls }] } },
    } } },
  } } })};</script>`;
}

function mockBot(t, scenario) {
  const messages = [];
  const uploads = [];
  const requests = [];
  const state = { pageFetches: 0, allowMedia: false, card: null };
  const previousAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    assert.ok(config.url === inputUrl || config.url === pageUrl ||
      [originalUrl, playbackUrl, freshUrl, backupUrl].includes(config.url), `Unexpected request: ${config.url}`);
    requests.push(config.url);
    let data;
    let headers = { "content-type": "text/html" };
    if (config.url === inputUrl && config.responseType === "stream") {
      data = Readable.from(["resolved"]);
    } else if (config.url === inputUrl || config.url === pageUrl) {
      state.pageFetches += 1;
      data = videoPage(
        scenario === "all cached sources expire" && state.pageFetches > 1 ? freshUrl : playbackUrl,
        scenario === "CDN backup" ? [backupUrl] : [],
        scenario !== "CDN backup" && !(scenario === "all cached sources expire" && state.pageFetches > 1)
      );
    } else {
      const blocked = scenario === "all blocked" ? !state.allowMedia
        : scenario === "CDN backup" ? config.url !== backupUrl
          : scenario === "all cached sources expire" ? config.url !== freshUrl
            : config.url === originalUrl;
      if (blocked) {
        const response = { data: Readable.from(["Forbidden"]), status: 403, config };
        throw Object.assign(new Error("Request failed with status code 403"), { response });
      }
      data = Readable.from([videoBytes]);
      headers = { "content-type": "video/mp4" };
    }
    return { data, status: 200, headers, config, request: { res: {
      responseUrl: config.url === inputUrl ? pageUrl : config.url,
    } } };
  };
  t.after(() => { axios.defaults.adapter = previousAdapter; });
  t.mock.method(bot, "sendMessage", async (chatId, text, options) => {
    messages.push(text);
    if (options?.reply_markup) state.card = options.reply_markup;
    return { message_id: messages.length };
  });
  t.mock.method(bot, "sendChatAction", async () => true);
  t.mock.method(bot, "deleteMessage", async () => true);
  t.mock.method(bot, "answerCallbackQuery", async () => true);
  for (const method of ["sendVideo", "sendAudio"]) {
    t.mock.method(bot, method, async (chatId, filePath, options) => {
      uploads.push({ method, bytes: await fs.readFile(filePath), filePath, options });
      return { message_id: 999 };
    });
  }
  t.mock.method(bot, "sendDocument", async () => assert.fail("media upload should succeed"));
  t.mock.method(childProcess, "spawn", (binary, args) => {
    assert.ok(args.includes("-acodec"), "yt-dlp must not run when a RedNote stream is available");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(async () => {
      await fs.writeFile(args.at(-1), Buffer.from("ID3-offline-audio"));
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { messages, uploads, requests, state };
}

for (const scenario of ["original blocked", "all cached sources expire", "CDN backup"]) {
  test(`RedNote AUTO_DOWNLOAD sends video when ${scenario}`, async (t) => {
    const { messages, uploads, requests, state } = mockBot(t, scenario);
    await processIncomingUrl(42, inputUrl, inputUrl);
    assert.equal(uploads.length, 1, messages.join("\n"));
    assert.equal(uploads[0].method, "sendVideo");
    assert.deepEqual(uploads[0].bytes, videoBytes);
    assert.equal(uploads[0].options.supports_streaming, true);
    assert.equal(state.pageFetches, scenario === "all cached sources expire" ? 2 : 1);
    if (scenario === "original blocked") {
      assert.ok(requests.indexOf(originalUrl) < requests.indexOf(playbackUrl));
      assert.equal(requests.filter((url) => url === originalUrl).length, 1);
    }
    if (scenario === "CDN backup") assert.ok(requests.includes(backupUrl));
    await assert.rejects(fs.stat(uploads[0].filePath), { code: "ENOENT" });
  });
}

test("RedNote audio reuses the working playback stream after original access fails", async (t) => {
  const { uploads, requests, state } = mockBot(t, "original blocked");
  await processIncomingUrl(42, inputUrl, inputUrl);
  const callbackData = state.card.inline_keyboard.flat().find((button) => button.text === "Audio").callback_data;
  const callback = bot.listeners("callback_query")[0];
  await callback({ id: "offline-audio", data: callbackData, message: { chat: { id: 42 } } });
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].method, "sendAudio");
  assert.deepEqual(uploads[1].bytes, Buffer.from("ID3-offline-audio"));
  assert.equal(requests.filter((url) => url === originalUrl).length, 1);
  await assert.rejects(fs.stat(uploads[1].filePath), { code: "ENOENT" });
});

test("a failed manual RedNote download can be retried with the same HD button", async (t) => {
  const { messages, uploads, state } = mockBot(t, "all blocked");
  await processIncomingUrl(42, inputUrl, inputUrl);
  assert.equal(uploads.length, 0);
  const callbackData = state.card.inline_keyboard.flat().find((button) => button.text === "HD Download").callback_data;
  const callback = bot.listeners("callback_query")[0];
  const query = { id: "offline-hd", data: callbackData, message: { chat: { id: 42 } } };
  await callback(query);
  assert.equal(uploads.length, 0);
  state.allowMedia = true;
  await callback(query);
  assert.equal(uploads.length, 1, messages.join("\n"));
  assert.deepEqual(uploads[0].bytes, videoBytes);
  assert.equal(messages.some((text) => /selection has expired/.test(text)), false);
  // Successful manual downloads still release their selection.
  await handleSelectionDownload(42, callbackData.split(":")[1], 0);
  assert.match(messages.at(-1), /selection has expired/);
});
