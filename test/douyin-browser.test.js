import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { getDouyinBrowserSources } from "../douyin-browser.js";
import { getDouyinFallbackSources } from "../douyin.js";

const id = "7676509727677994432";
const pageUrl = `https://www.douyin.com/video/${id}`;
const item = (awemeId = id) => ({ aweme_detail: {
  aweme_id: awemeId,
  video: { width: 1080, height: 1920, play_addr: { url_list: ["https://media.example/video.mp4"] } },
} });

function fakeBrowser({ responses = [], navigationError, neverRespond = false, playerSources } = {}) {
  const calls = { closed: 0, launches: 0, routes: [] };
  const page = new EventEmitter();
  page.evaluate = async (callback, expectedId) => expectedId ? playerSources : "Desktop Chromium";
  page.goto = async (url) => {
    assert.equal(new URL(url).pathname, new URL(pageUrl).pathname);
    if (navigationError) throw new Error(navigationError);
    if (!neverRespond) for (const response of responses) page.emit("response", response);
  };
  const context = {
    route: async (pattern, handler) => { calls.routes.push(handler); },
    newPage: async () => page,
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  const browserType = { launch: async (options) => {
    calls.launches += 1;
    calls.options = options;
    assert.equal(options.headless, true);
    return { newContext: async () => context, close: async () => { calls.closed += 1; } };
  } };
  return { browserType, calls };
}

const response = (data, url = "https://www.douyin.com/aweme/v1/web/aweme/detail/") => ({
  url: () => url, ok: () => true, json: async () => data,
});

test("browser fallback captures only the requested post and closes Chromium", async () => {
  const fake = fakeBrowser({ responses: [
    response(item("1111111111111111111")),
    response(item(), "https://evil.example/aweme/v1/web/aweme/detail/"),
    response(item(), "https://www.douyin.com/aweme/v1/web/aweme/related/"),
    response(item()),
  ] });
  const result = await getDouyinBrowserSources(id, fake);
  assert.equal(result.videoId, id);
  assert.equal(result.sources[0].headers["User-Agent"], "Desktop Chromium");
  assert.equal(result.sources[0].headers.Cookie, undefined);
  assert.equal(fake.calls.closed, 1);
});

test("browser timeouts and navigation failures release the browser and extraction queue", async () => {
  for (const options of [{ neverRespond: true }, { navigationError: "Connection refused" }]) {
    const fake = fakeBrowser(options);
    await assert.rejects(getDouyinBrowserSources(id, { ...fake, timeoutMs: 10 }), /timeout|navigation failed/);
    assert.equal(fake.calls.closed, 1);
  }
  const healthy = fakeBrowser({ responses: [response(item())] });
  assert.equal((await getDouyinBrowserSources(id, healthy)).videoId, id);
});

test("browser jobs run sequentially on small workers", async () => {
  const fake = fakeBrowser({ responses: [response(item())] });
  const originalLaunch = fake.browserType.launch;
  fake.browserType.launch = async (options) => {
    assert.equal(fake.calls.launches, fake.calls.closed);
    return originalLaunch(options);
  };
  await Promise.all([getDouyinBrowserSources(id, fake), getDouyinBrowserSources(id, fake)]);
  assert.equal(fake.calls.closed, 2);
});

test("browser can use the player source when metadata responses are missing", async () => {
  const fake = fakeBrowser({ neverRespond: true, playerSources: [{
    label: "572p", directUrl: `https://media.example/video.mp4?__vid=${id}`,
  }] });
  const result = await getDouyinBrowserSources(id, { ...fake, timeoutMs: 2000 });
  assert.equal(result.videoId, id);
  assert.equal(result.sources[0].label, "572p");
  assert.equal(fake.calls.closed, 1);
});

test("HTTP extraction falls back to a desktop browser after access blocks", async () => {
  let browserCalls = 0;
  const result = await getDouyinFallbackSources(pageUrl, pageUrl, {
    httpClient: async () => ({ status: 403, data: "Access check" }),
    browserFallback: async (videoId) => {
      browserCalls += 1;
      assert.equal(videoId, id);
      return { videoId, sources: [{ directUrl: "https://media.example/video.mp4" }] };
    },
  });
  assert.equal(result.videoId, id);
  assert.equal(browserCalls, 1);
});
