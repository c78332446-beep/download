import assert from "node:assert/strict";
import test from "node:test";
import {
  DOUYIN_MOBILE_SHARE_HEADERS,
  downloadDouyinDirectFileWithRetry,
  extractDouyinSources,
  extractDouyinSourcesFromHtml,
  extractDouyinVideoId,
  getDouyinFallbackSources,
  isDouyinUrl,
} from "../douyin.js";
import { extractUrls } from "../share-links.js";

const id = "7681979274496183552";
const pageUrl = `https://www.douyin.com/video/${id}`;
const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
const item = (overrides = {}) => ({
  aweme_id: id,
  desc: 'Text with braces } and an escaped quote "',
  video: {
    width: 1080, height: 1920,
    play_addr: { url_list: ["https://media.example/playwm/video?token=a%2Bb", "https://backup.example/play/video?token=keep%3D"] },
    cover: { url_list: ["https://media.example/cover.jpg"] },
  },
  ...overrides,
});
const html = (items = [item()]) => `<script>window._ROUTER_DATA=${JSON.stringify({
  loaderData: { "video_(id)/page": { videoInfoRes: { item_list: items } } },
})}; window.unrelated = {};</script>`;

test("shared URLs stop at Chinese punctuation and preserve signed parameters", () => {
  assert.deepEqual(extractUrls('5.30 复制打开抖音 https://v.douyin.com/example/，看看作品。'), ["https://v.douyin.com/example/"]);
  assert.deepEqual(extractUrls(`(${pageUrl}?token=a%2Bb%3D). ${pageUrl}?token=a%2Bb%3D`), [`${pageUrl}?token=a%2Bb%3D`]);
  assert.deepEqual(extractUrls('https://v.douyin.com/example/:0pm 10/25'), ["https://v.douyin.com/example/"]);
  assert.deepEqual(extractUrls('https://v.douyin.com/example/?token=a%2Bb'), ["https://v.douyin.com/example/?token=a%2Bb"]);
});

test("Douyin IDs include modal links and host validation rejects lookalikes", () => {
  for (const url of [pageUrl, shareUrl, `https://www.douyin.com/?modal_id=${id}`, `https://www.douyin.com/discover?aweme_id=${id}`]) {
    assert.equal(extractDouyinVideoId(url), id);
  }
  for (const url of ["https://douyin.com.evil.example/video/123", "https://example.com/?url=https://www.douyin.com/video/123", "ftp://douyin.com/video/123", null]) {
    assert.equal(isDouyinUrl(url), false);
    assert.equal(extractDouyinVideoId(url), null);
  }
});

test("router parser accepts compact assignments, semicolons, and subsequent JavaScript", () => {
  const result = extractDouyinSourcesFromHtml(html(), pageUrl);
  assert.equal(result.videoId, id);
  assert.equal(result.sources[0].label, "1080p");
  assert.equal(result.sources[0].directUrl, "https://media.example/play/video?token=a%2Bb");
  assert.deepEqual(result.sources[0].alternateUrls, ["https://backup.example/play/video?token=keep%3D"]);
  assert.equal(result.sources[0].headers, DOUYIN_MOBILE_SHARE_HEADERS);
  assert.equal(result.thumbnailUrl, "https://media.example/cover.jpg");
});

test("router JSON string assignments and encoded desktop data are supported", () => {
  const data = { aweme_detail: item() };
  const stringAssignment = `<script>window._ROUTER_DATA = ${JSON.stringify(JSON.stringify(data))};</script>`;
  const renderData = `<script type="application/json" id='RENDER_DATA'>${encodeURIComponent(JSON.stringify(data))}</script>`;
  for (const fixture of [stringAssignment, renderData]) {
    assert.equal(extractDouyinSourcesFromHtml(fixture, pageUrl).videoId, id);
  }
});

test("only the requested post is downloaded when recommendations are present", () => {
  const recommendation = item({ aweme_id: "1111111111111111111", video: { play_addr: { url_list: ["https://wrong.example/video.mp4"] } } });
  assert.equal(extractDouyinSourcesFromHtml(html([recommendation, item()]), pageUrl).sources[0].directUrl.includes("media.example"), true);
  assert.throws(() => extractDouyinSourcesFromHtml(html([recommendation]), pageUrl), /requested post/);
});

test("photo posts are rejected even when recommendations have video", () => {
  assert.throws(() => extractDouyinSourcesFromHtml(html([item({ video: undefined, images: [{ url_list: ["https://media.example/photo.jpg"] }] })]), pageUrl), /photo-only/);
});

test("bitrate renditions retain backup URLs and codec information", () => {
  const result = extractDouyinSources({ aweme_detail: item({ video: {
    width: 1080, height: 1920,
    bit_rate: [{ is_h265: 1, play_addr: { width: 720, height: 1280, url_list: ["https://media.example/hevc.mp4"] } }],
    play_addr: { url_list: ["https://media.example/avc.mp4"] },
  } }) }, pageUrl);
  assert.deepEqual(result.sources.map((source) => source.label), ["720p H265", "1080p"]);
});

test("first-party API fallback handles share pages that contain no video data", async () => {
  const calls = [];
  const cookie = "sessionid=private-test-cookie";
  const result = await getDouyinFallbackSources(pageUrl, pageUrl, {
    cookie,
    httpClient: async (config) => {
      calls.push(config);
      return { status: 200, data: config.url.includes("/aweme/detail/") ? { aweme_detail: item() } : "<html>App shell</html>" };
    },
  });
  assert.equal(result.videoId, id);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, shareUrl);
  assert.equal(calls.every((call) => call.headers.Cookie === cookie), true);
  assert.equal(result.sources[0].headers.Cookie, undefined);
});

test("mobile short-link redirects discover the canonical share page", async () => {
  const shortUrl = "https://v.douyin.com/example/";
  const calls = [];
  const result = await getDouyinFallbackSources(shortUrl, shortUrl, {
    httpClient: async (config) => {
      calls.push(config.url);
      return config.url === shortUrl
        ? { status: 200, data: "<html>App shell</html>", request: { res: { responseUrl: pageUrl } } }
        : { status: 200, data: html() };
    },
  });
  assert.deepEqual(calls, [shortUrl, shareUrl]);
  assert.equal(result.videoId, id);
});

test("redirects cannot replace an explicit requested video ID", async () => {
  const result = await getDouyinFallbackSources(pageUrl, "https://www.douyin.com/video/1111111111111111111", {
    httpClient: async (config) => {
      assert.equal(config.url, shareUrl);
      return { status: 200, data: html() };
    },
  });
  assert.equal(result.videoId, id);
});

test("blocked pages produce an actionable Douyin error", async () => {
  await assert.rejects(getDouyinFallbackSources(pageUrl, pageUrl, {
    httpClient: async () => ({ status: 403, data: "Blocked" }),
  }), /Douyin.*browser session/);
  await assert.rejects(getDouyinFallbackSources("https://v.douyin.com/expired/", "https://www.douyin.com/", {
    httpClient: async () => ({ status: 200, data: html(), request: { res: { responseUrl: "https://www.douyin.com/" } } }),
  }), /fresh video share link/);
});

test("expired direct media is refreshed once and the audio choice is preserved", async () => {
  const selection = { originalUrl: "https://v.douyin.com/example/", finalUrl: pageUrl };
  const choice = { kind: "audio", text: "Audio", directUrl: "https://media.example/expired.mp4" };
  const urls = [];
  let refreshes = 0;
  await downloadDouyinDirectFileWithRetry(selection, choice, "unused.mp4", {
    download: async (selected) => {
      urls.push(selected.directUrl);
      if (urls.length === 1) throw new Error("403 expired");
    },
    getSources: async (original, final) => {
      refreshes += 1;
      assert.equal(original, selection.originalUrl);
      assert.equal(final, pageUrl);
      return { sources: [{ label: "1080p", directUrl: "https://media.example/fresh.mp4", alternateUrls: ["https://backup.example/fresh.mp4"] }], pageUrl };
    },
  });
  assert.equal(refreshes, 1);
  assert.deepEqual(urls, ["https://media.example/expired.mp4", "https://media.example/fresh.mp4"]);
  assert.equal(choice.kind, "audio");
  assert.equal(choice.text, "Audio");
  assert.deepEqual(choice.alternateUrls, ["https://backup.example/fresh.mp4"]);
});

test("download limits do not trigger a redundant Douyin refresh", async () => {
  const error = Object.assign(new Error("too large"), { code: "MEDIA_TOO_LARGE" });
  await assert.rejects(downloadDouyinDirectFileWithRetry({}, {}, "unused.mp4", {
    download: async () => { throw error; },
    getSources: async () => assert.fail("should not refresh an oversized download"),
  }), (result) => result === error);
});
