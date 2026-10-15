import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import {
  extractRedNotePostId,
  extractRedNoteSourcesFromHtml,
  getRedNoteFallbackSources,
  isRedNoteUrl,
  REDNOTE_HEADERS,
  REDNOTE_MOBILE_HEADERS,
} from "../rednote.js";
import { resolveFinalUrl } from "../url-resolver.js";

const SAMPLE_NOTE_ID = "6a5a4fcc0000000001032dfa";

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("RedNote URL recognition accepts platform hosts and rejects lookalikes", () => {
  const accepted = [
    "http://xhslink.com/o/89by8DBQW4X",
    "https://WWW.XHSLINK.COM/o/89by8DBQW4X",
    `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}?xsec_token=abc`,
    `https://xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`,
    `https://www.rednote.com/explore/${SAMPLE_NOTE_ID}`,
  ];
  const rejected = [
    "https://xhslink.com.evil.example/o/89by8DBQW4X",
    `https://notxiaohongshu.com/explore/${SAMPLE_NOTE_ID}`,
    "https://example.com/?next=https://xhslink.com/o/example",
    "ftp://xhslink.com/o/example",
    "not a url",
    null,
  ];

  for (const url of accepted) {
    assert.equal(isRedNoteUrl(url), true, String(url));
  }
  for (const url of rejected) {
    assert.equal(isRedNoteUrl(url), false, String(url));
  }
});

test("RedNote post ID extraction supports canonical page forms", () => {
  assert.equal(
    extractRedNotePostId(
      `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}?xsec_token=keep%3D`
    ),
    SAMPLE_NOTE_ID
  );
  assert.equal(
    extractRedNotePostId(`https://www.rednote.com/explore/${SAMPLE_NOTE_ID}`),
    SAMPLE_NOTE_ID
  );
  assert.equal(extractRedNotePostId("http://xhslink.com/o/89by8DBQW4X"), null);
});

test("resolver falls through from HEAD 404 to GET and preserves signed redirect", async (t) => {
  const requests = [];
  const finalTarget =
    `/discovery/item/${SAMPLE_NOTE_ID}` +
    "?xsec_token=a%3D%3D&xsec_source=pc_share";
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);

    if (request.method === "HEAD" && request.url === "/o/example") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET" && request.url === "/o/example") {
      response.writeHead(302, { Location: finalTarget }).end();
      return;
    }
    if (request.method === "GET" && request.url === finalTarget) {
      response.writeHead(200, { "Content-Type": "text/html" }).end("ok");
      return;
    }
    response.writeHead(500).end("unexpected request");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const resolved = await resolveFinalUrl(`${baseUrl}/o/example`, {
    headers: { "User-Agent": "rednote-test" },
    timeoutMs: 2000,
  });

  assert.equal(resolved, `${baseUrl}${finalTarget}`);
  assert.deepEqual(requests, [
    "HEAD /o/example",
    "GET /o/example",
    `GET ${finalTarget}`,
  ]);
});

test("resolver can skip unreliable HEAD requests", async () => {
  const calls = [];
  let destroyed = false;
  const finalUrl =
    `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}` +
    "?xsec_token=keep%3D";
  const httpClient = async (config) => {
    calls.push(config.method);
    return {
      status: 200,
      request: { res: { responseUrl: finalUrl } },
      data: {
        destroy() {
          destroyed = true;
        },
      },
    };
  };

  const resolved = await resolveFinalUrl("http://xhslink.com/o/example", {
    skipHead: true,
    httpClient,
  });

  assert.equal(resolved, finalUrl);
  assert.deepEqual(calls, ["GET"]);
  assert.equal(destroyed, true);
});

test("resolver keeps the original URL when HEAD and GET both fail", async () => {
  const originalUrl = "https://example.invalid/video";
  const resolved = await resolveFinalUrl(originalUrl, {
    httpClient: async () => {
      throw new Error("network unavailable");
    },
  });
  assert.equal(resolved, originalUrl);
});

function buildVideoFixture() {
  return `<!doctype html>
<script>
window.__INITIAL_STATE__={
  "global":{"firstVisitUrl":undefined},
  "note":{
    "noteDetailMap":{
      "${SAMPLE_NOTE_ID}":{
        "note":{
          "noteId":"${SAMPLE_NOTE_ID}",
          "type":"video",
          "imageList":[{
            "urlDefault":"https:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fdemo-cover.jpg"
          }],
          "video":{"media":{"stream":{
            "h264":[{
              "width":720,
              "height":1280,
              "format":"mp4",
              "videoCodec":"h264",
              "qualityType":"HD",
              "size":2469226,
              "masterUrl":"https:\\u002F\\u002Fsns-video-zl.xhscdn.com\\u002Fstream\\u002Fdemo_258.mp4?sign=a%2Bb&t=1",
              "backupUrls":["https:\\u002F\\u002Fsns-bak-v8.xhscdn.com\\u002Fstream\\u002Fdemo_258.mp4"]
            }],
            "h265":undefined
          }}}
        }
      }
    }
  }
};
</script>`;
}

test("RedNote HTML fallback extracts video, backup, thumbnail, and headers", () => {
  const pageUrl =
    `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}` +
    "?xsec_token=keep%3D";
  const result = extractRedNoteSourcesFromHtml(buildVideoFixture(), pageUrl);

  assert.equal(result.noteId, SAMPLE_NOTE_ID);
  assert.equal(
    result.thumbnailUrl,
    "https://sns-webpic-qc.xhscdn.com/demo-cover.jpg"
  );
  assert.equal(result.sources.length, 1);
  assert.equal(
    result.sources[0].directUrl,
    "https://sns-video-zl.xhscdn.com/stream/demo_258.mp4?sign=a%2Bb&t=1"
  );
  assert.deepEqual(result.sources[0].alternateUrls, [
    "https://sns-bak-v8.xhscdn.com/stream/demo_258.mp4",
  ]);
  assert.match(result.sources[0].label, /720p/i);
  assert.equal(result.sources[0].headers.Referer, pageUrl);
});

test("RedNote HTML fallback reports photo-only posts clearly", () => {
  const html = `<script>window.__INITIAL_STATE__={
    "note":{"noteDetailMap":{"${SAMPLE_NOTE_ID}":{"note":{
      "noteId":"${SAMPLE_NOTE_ID}",
      "type":"normal",
      "imageList":[{"urlDefault":"https://example.com/photo.jpg"}]
    }}}}
  };</script>`;

  assert.throws(
    () =>
      extractRedNoteSourcesFromHtml(
        html,
        `https://www.xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`
      ),
    /photo-only/i
  );
});

test("RedNote exposes the original even when playback streams are available", () => {
  const html = buildVideoFixture().replace(
    '"video":{"media":',
    '"video":{"consumer":{"originVideoKey":"pre_post/clean-original"},"media":'
  );
  const { sources } = extractRedNoteSourcesFromHtml(
    html,
    `https://www.xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`
  );
  assert.equal(sources.length, 2);
  const original = sources.find((source) => source.isOriginal);
  assert.equal(original.label, "Original");
  assert.equal(original.directUrl, "https://sns-video-bd.xhscdn.com/pre_post/clean-original");
  // Never retry a badged playback rendition as an alternate for the original.
  assert.deepEqual(original.alternateUrls, []);
  assert.equal(sources.find((source) => source.label === "720p").isOriginal, false);
});

test("RedNote extracts original-only posts from both consumer field shapes", () => {
  for (const video of [
    { consumer: { origin_video_key: " /pre_post/clean-original " } },
    { mediaV2: JSON.stringify({ video: { consumer: { originVideoKey: "pre_post/clean-original" } } }) },
  ]) {
    const state = { noteData: { data: { noteData: {
      note_id: SAMPLE_NOTE_ID, type: "video", video,
    } } } };
    const { sources } = extractRedNoteSourcesFromHtml(
      `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`,
      `https://www.xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`
    );
    assert.equal(sources.length, 1);
    assert.equal(sources[0].isOriginal, true);
    assert.equal(sources[0].directUrl, "https://sns-video-bd.xhscdn.com/pre_post/clean-original");
  }
});

test("RedNote HTML fallback supports the mobile noteData state shape", () => {
  const html = `<script>window.__INITIAL_STATE__={
    "noteData":{"data":{"noteData":{
      "note_id":"${SAMPLE_NOTE_ID}",
      "type":"video",
      "image_list":[{"url_default":"https://example.com/mobile-cover.jpg"}],
      "video":{"media":{"stream":{"h265":[{
        "width":1080,
        "height":1920,
        "video_codec":"h265",
        "master_url":"https://sns-video-hw.xhscdn.com/mobile.mp4",
        "backup_urls":[]
      }]}}}
    }}}
  };</script>`;
  const result = extractRedNoteSourcesFromHtml(
    html,
    `https://www.xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`
  );

  assert.equal(result.noteId, SAMPLE_NOTE_ID);
  assert.equal(result.thumbnailUrl, "https://example.com/mobile-cover.jpg");
  assert.equal(result.sources[0].directUrl, "https://sns-video-hw.xhscdn.com/mobile.mp4");
  assert.match(result.sources[0].label, /1080p H265/i);
});

test("RedNote HTML fallback never substitutes another hydrated post", () => {
  const otherNoteId = "111111111111111111111111";
  const html = `<script>window.__INITIAL_STATE__={
    "note":{"noteDetailMap":{"${otherNoteId}":{"note":{
      "noteId":"${otherNoteId}",
      "type":"video",
      "video":{"media":{"stream":{"h264":[{
        "width":720,
        "height":1280,
        "masterUrl":"https://example.com/wrong-video.mp4"
      }]}}}
    }}}}
  };</script>`;

  assert.throws(
    () =>
      extractRedNoteSourcesFromHtml(
        html,
        `https://www.xiaohongshu.com/explore/${SAMPLE_NOTE_ID}`
      ),
    /requested post/i
  );
});

test("RedNote fetch fallback retries the original short link", async () => {
  const inputUrl = "http://xhslink.com/o/example";
  const expiredUrl =
    `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}` +
    "?xsec_token=expired";
  const refreshedUrl =
    `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}` +
    "?xsec_token=fresh";
  const calls = [];
  const httpClient = async (config) => {
    calls.push(config.url);
    if (config.url === expiredUrl) {
      return { status: 403, data: "expired" };
    }
    return {
      status: 200,
      data: buildVideoFixture(),
      request: { res: { responseUrl: refreshedUrl } },
    };
  };

  const result = await getRedNoteFallbackSources(inputUrl, expiredUrl, {
    httpClient,
  });

  assert.deepEqual(calls, [expiredUrl, inputUrl]);
  assert.equal(result.pageUrl, refreshedUrl);
  assert.equal(result.noteId, SAMPLE_NOTE_ID);
  assert.equal(result.sources.length, 1);
});

test("RedNote mobile fallback recovers the signed post from a desktop feed redirect", async () => {
  const feedUrl = `https://www.xiaohongshu.com/explore?target_note_id=${SAMPLE_NOTE_ID}&xsec_token=a%2Bb%3D&undertake_note_error=unavailable`;
  assert.equal(extractRedNotePostId(feedUrl), SAMPLE_NOTE_ID);
  const result = await getRedNoteFallbackSources("http://xhslink.com/o/example", feedUrl, {
    httpClient: async (config) => {
      const url = new URL(config.url);
      assert.equal(url.pathname, `/discovery/item/${SAMPLE_NOTE_ID}`);
      assert.equal(url.searchParams.get("xsec_token"), "a+b=");
      assert.equal(url.searchParams.has("undertake_note_error"), false);
      assert.equal(config.headers["User-Agent"], REDNOTE_MOBILE_HEADERS["User-Agent"]);
      return { status: 200, data: buildVideoFixture() };
    },
  });
  assert.equal(result.noteId, SAMPLE_NOTE_ID);
  assert.equal(result.sources[0].headers["User-Agent"], REDNOTE_MOBILE_HEADERS["User-Agent"]);
  assert.equal(result.sources[0].headers.Referer, result.pageUrl);
});

test("RedNote retains desktop extraction when the mobile page has no media", async () => {
  const url = `https://www.xiaohongshu.com/discovery/item/${SAMPLE_NOTE_ID}?xsec_token=keep=`;
  const calls = [];
  const result = await getRedNoteFallbackSources(url, url, {
    httpClient: async (config) => {
      assert.equal(config.url, url);
      calls.push(config.headers["User-Agent"]);
      return {
        status: 200,
        data: calls.length === 1 ? "<html>Unavailable</html>" : buildVideoFixture(),
      };
    },
  });
  assert.deepEqual(calls, [REDNOTE_MOBILE_HEADERS["User-Agent"], REDNOTE_HEADERS["User-Agent"]]);
  assert.equal(result.sources[0].headers["User-Agent"], REDNOTE_HEADERS["User-Agent"]);
});

test("RedNote feed redirects cannot substitute a different hydrated post", () => {
  assert.throws(
    () => extractRedNoteSourcesFromHtml(
      buildVideoFixture(),
      "https://www.xiaohongshu.com/explore?target_note_id=111111111111111111111111"
    ),
    /requested post/i
  );
});
