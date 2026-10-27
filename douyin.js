import axios from "axios";

export const DOUYIN_MOBILE_SHARE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.douyin.com/",
};

export function isDouyinUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      /^(?:(?:www|v)\.)?(?:douyin|iesdouyin)\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function extractDouyinVideoId(value) {
  if (!isDouyinUrl(value)) return null;
  const url = new URL(value);
  const pathId = url.pathname.match(/\/(?:video|note|slides)\/(\d+)(?:\/|$)/i)?.[1];
  if (pathId) return pathId;
  for (const key of ["modal_id", "aweme_id", "item_ids"]) {
    const id = url.searchParams.get(key);
    if (/^\d+$/.test(id || "")) return id;
  }
  return null;
}

// Scan JSON without evaluating scripts or depending on a trailing semicolon.
function readJsonAssignment(html, name) {
  const marker = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`).exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const stringLiteral = html[start] === '"';
  if (!stringLiteral && html[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (stringLiteral) return JSON.parse(JSON.parse(html.slice(start, index + 1)));
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && --depth === 0) {
      return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error("Douyin page contains incomplete video data.");
}

function mediaUrls(address) {
  const values = typeof address === "string" ? [address] : address?.url_list || address?.urlList || [];
  return (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === "string" && /^https?:\/\//i.test(value)
  );
}

function resolutionLabel(video) {
  const dimensions = [Number(video?.width), Number(video?.height)].filter((value) => value > 0);
  return dimensions.length ? `${Math.min(...dimensions)}p` : "Default";
}

export function extractDouyinSources(data, pageUrl, headers = DOUYIN_MOBILE_SHARE_HEADERS) {
  const expectedId = extractDouyinVideoId(pageUrl);
  const items = [];
  const stack = [data];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value) && (value.video || Array.isArray(value.images))) items.push(value);
    stack.push(...Object.values(value));
  }
  const itemId = (item) => String(item.aweme_id || item.awemeId || item.id || "");
  const item = expectedId
    ? items.find((entry) => itemId(entry) === expectedId) ||
      (items.length === 1 && !itemId(items[0]) ? items[0] : null)
    : items.length === 1 ? items[0] : null;
  if (!item) throw new Error("Douyin page did not provide video data for the requested post.");
  if (item.images?.length) throw new Error("Douyin post is photo-only and has no downloadable video.");

  const video = item.video || {};
  const sources = [];
  const seen = new Set();
  const addSource = (address, rendition = video, codec = "") => {
    const urls = mediaUrls(address).map((url) => url.replace("/playwm/", "/play/"));
    if (!urls.length) return;
    const directUrl = urls[0];
    if (seen.has(directUrl)) return;
    seen.add(directUrl);
    const h265 = /h265|hevc/i.test(codec) || rendition.is_h265 === 1 || rendition.isH265 === 1;
    sources.push({
      label: `${resolutionLabel(rendition)}${h265 ? " H265" : ""}`,
      directUrl,
      alternateUrls: [...new Set(urls.slice(1))].filter((url) => url !== directUrl),
      headers,
    });
  };

  for (const bitrate of video.bit_rate || video.bitRate || []) {
    const address = bitrate.play_addr || bitrate.playAddr;
    addSource(address, { ...video, ...bitrate, ...address }, String(bitrate.gear_name || bitrate.gearName || ""));
  }
  addSource(video.play_addr_h264 || video.playAddrH264);
  addSource(video.play_addr || video.playAddr);
  addSource(video.play_addr_265 || video.playAddrH265, video, "H265");
  if (!sources.length) throw new Error("Douyin post did not provide a playable video URL.");
  return {
    sources,
    videoId: itemId(item) || expectedId,
    thumbnailUrl: mediaUrls(video.origin_cover || video.originCover || video.cover)[0] || null,
    pageUrl,
  };
}

export function extractDouyinSourcesFromHtml(html, pageUrl) {
  if (typeof html !== "string") throw new Error("Douyin page did not return HTML.");
  const states = [];
  let parseError;
  try {
    const router = readJsonAssignment(html, "window._ROUTER_DATA");
    if (router) states.push(router);
  } catch (error) {
    parseError = error;
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bid\s*=\s*["'](?:RENDER_DATA|SIGI_STATE)["']/i.test(match[1])) continue;
    try {
      const body = match[2].trim();
      states.push(JSON.parse(body.startsWith("%") ? decodeURIComponent(body) : body));
    } catch (error) {
      parseError = error;
    }
  }
  if (!states.length) {
    throw new Error(`Douyin page has no readable video data${parseError ? `: ${parseError.message}` : "."}`);
  }
  return extractDouyinSources(states, pageUrl);
}

export async function getDouyinFallbackSources(inputUrl, finalUrl, {
  timeoutMs = 15000,
  logger = () => {},
  httpClient = axios,
  cookie = "",
} = {}) {
  let videoId = extractDouyinVideoId(inputUrl) || extractDouyinVideoId(finalUrl);
  const candidates = [...new Set([
    videoId && `https://www.iesdouyin.com/share/video/${videoId}/`,
    inputUrl,
    finalUrl,
  ].filter((url) => url && isDouyinUrl(url)))];
  const headers = { ...DOUYIN_MOBILE_SHARE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
  const failures = [];
  const fetch = async (url) => {
    logger(`[fallback] Douyin fetch: ${url}`);
    const response = await httpClient({
      method: "GET", url, timeout: timeoutMs, maxRedirects: 10,
      headers, validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Douyin page fetch failed (status ${response.status}).`);
    }
    return response;
  };
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      const responseUrl = response.request?.res?.responseUrl || response.request?._currentUrl || candidate;
      const resolvedId = extractDouyinVideoId(responseUrl);
      if (!videoId && !resolvedId && new URL(responseUrl).pathname === "/") {
        throw new Error("Douyin share redirected to the homepage instead of a video.");
      }
      if (resolvedId && !videoId) {
        videoId = resolvedId;
        const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
        if (!candidates.includes(shareUrl)) candidates.push(shareUrl);
      }
      // Keep the requested identity even when a server redirects to a feed.
      const pageUrl = videoId ? `https://www.douyin.com/video/${videoId}` : responseUrl;
      return extractDouyinSourcesFromHtml(response.data, pageUrl);
    } catch (error) {
      if (/photo-only/.test(error.message)) throw error;
      failures.push(error.message);
      logger(`[fallback] Douyin candidate failed: ${error.message}`);
    }
  }
  // Share pages can contain only the app shell. Try first-party JSON as well.
  if (videoId) {
    for (const url of [
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}&aid=6383&device_platform=webapp`,
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`,
    ]) {
      try {
        const response = await fetch(url);
        const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        return extractDouyinSources(data, `https://www.douyin.com/video/${videoId}`);
      } catch (error) {
        if (/photo-only/.test(error.message)) throw error;
        failures.push(error.message);
        logger(`[fallback] Douyin API failed: ${error.message}`);
      }
    }
  }
  logger(`[fallback] Douyin extraction failed: ${failures.join(" | ")}`);
  throw new Error(videoId
    ? "Douyin did not provide a public video stream. A fresh browser session (DOUYIN_COOKIE or COOKIES_FROM_BROWSER) or a different server region may be required."
    : "Douyin share link did not resolve to a video. Copy a fresh video share link from Douyin and send it again.");
}

export async function downloadDouyinDirectFileWithRetry(selection, choice, filePath, {
  download,
  getSources = getDouyinFallbackSources,
  logger = () => {},
  fallbackOptions = {},
}) {
  try {
    await download(choice, filePath);
    return;
  } catch (error) {
    if (error.code === "MEDIA_TOO_LARGE") throw error;
    logger(`[fallback] Douyin media failed; refreshing video URLs: ${error.message}`);
  }
  const refreshed = await getSources(selection.originalUrl, selection.finalUrl, fallbackOptions);
  const source = refreshed.sources.find((entry) => entry.label === choice.text) ||
    refreshed.sources.find((entry) => !/H265|HEVC/i.test(entry.label)) || refreshed.sources[0];
  if (!source) throw new Error("Douyin refresh did not provide a playable video URL.");
  Object.assign(choice, {
    directUrl: source.directUrl, alternateUrls: source.alternateUrls, headers: source.headers,
  });
  if (refreshed.pageUrl) selection.finalUrl = refreshed.pageUrl;
  await download(choice, filePath);
}
