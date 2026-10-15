import axios from "axios";

const REDNOTE_BASE_HOSTS = [
  "xhslink.com",
  "xiaohongshu.com",
  "rednote.com",
];

export const REDNOTE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export const REDNOTE_MOBILE_HEADERS = {
  ...REDNOTE_HEADERS,
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

function isSameOrSubdomain(hostname, baseHostname) {
  return hostname === baseHostname || hostname.endsWith(`.${baseHostname}`);
}

export function isRedNoteUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return REDNOTE_BASE_HOSTS.some((baseHostname) =>
      isSameOrSubdomain(hostname, baseHostname)
    );
  } catch {
    return false;
  }
}

export function extractRedNotePostId(value) {
  if (typeof value !== "string") return null;

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(
      /\/(?:explore|discovery\/item|note)\/([\da-f]{24})(?:\/|$)/i
    );
    if (match) return match[1];
    const targetId = parsed.searchParams.get("target_note_id");
    return /^[\da-f]{24}$/i.test(targetId || "") ? targetId : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeJsonLikeSource(source) {
  let output = "";
  let stringQuote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (stringQuote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      stringQuote = char;
      output += char;
      continue;
    }

    const previousChar = source[index - 1] || "";
    const afterUndefined = source[index + "undefined".length] || "";
    if (
      source.startsWith("undefined", index) &&
      !/[a-zA-Z0-9_$]/.test(previousChar) &&
      !/[a-zA-Z0-9_$]/.test(afterUndefined)
    ) {
      output += "null";
      index += "undefined".length - 1;
      continue;
    }

    output += char;
  }

  return output;
}

function extractJsonAssignment(html, variableName) {
  if (typeof html !== "string") {
    throw new Error("RedNote fallback page did not return HTML.");
  }

  const marker = new RegExp(`${escapeRegExp(variableName)}\\s*=\\s*`, "i");
  const markerMatch = marker.exec(html);
  if (!markerMatch) {
    throw new Error(`${variableName} assignment was not found in RedNote HTML.`);
  }

  const jsonStart = html.indexOf("{", markerMatch.index + markerMatch[0].length);
  if (jsonStart < 0) {
    throw new Error(`${variableName} assignment does not contain a JSON object.`);
  }

  let depth = 0;
  let stringQuote = null;
  let escaped = false;

  for (let index = jsonStart; index < html.length; index += 1) {
    const char = html[index];

    if (stringQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const source = html.slice(jsonStart, index + 1);
        try {
          return JSON.parse(normalizeJsonLikeSource(source));
        } catch (error) {
          throw new Error(`RedNote initial state parse failed: ${error.message}`);
        }
      }
    }
  }

  throw new Error(`${variableName} JSON block is incomplete.`);
}

function parseMediaV2(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pickRedNoteEntry(initialState, pageUrl) {
  const requestedId = extractRedNotePostId(pageUrl);
  const detailMap = initialState?.note?.noteDetailMap;
  if (detailMap && typeof detailMap === "object") {
    if (requestedId) {
      const requestedEntry = detailMap[requestedId] ||
        Object.values(detailMap).find(
          (entry) =>
            entry?.note?.noteId === requestedId ||
            entry?.note?.note_id === requestedId
        );
      if (requestedEntry?.note) {
        return requestedEntry;
      }
      throw new Error("RedNote fallback note detail did not contain the requested post.");
    }

    const entries = Object.values(detailMap).filter(
      (entry) => entry?.note && typeof entry.note === "object"
    );
    const videoEntry = entries.find(
      (entry) => entry.note.type === "video" || entry.note.video
    );
    if (videoEntry) return videoEntry;
    if (entries[0]) return entries[0];
  }

  const mobileNote = initialState?.noteData?.data?.noteData;
  if (mobileNote && typeof mobileNote === "object") {
    const note = mobileNote.note && typeof mobileNote.note === "object"
      ? mobileNote.note
      : mobileNote;
    const mobileNoteId = note.noteId || note.note_id;
    if (requestedId && mobileNoteId && mobileNoteId !== requestedId) {
      throw new Error("RedNote fallback mobile note did not match the requested post.");
    }
    return { note };
  }

  throw new Error("RedNote fallback could not find note detail data.");
}

function getResolutionLabel(item = {}, fallbackVideo = {}) {
  const width = Number(item.width || fallbackVideo.width || 0);
  const height = Number(item.height || fallbackVideo.height || 0);
  const shortEdge = width > 0 && height > 0
    ? Math.min(width, height)
    : Math.max(width, height);
  return shortEdge > 0 ? `${shortEdge}p` : "";
}

function getCodecLabel(item = {}, streamName = "") {
  const codec = String(
    item.videoCodec ||
    item.video_codec ||
    item.codec ||
    streamName ||
    ""
  ).toLowerCase();
  if (!codec || /^(?:h264|avc)$/.test(codec)) return "";
  return codec.toUpperCase();
}

function buildSourceLabel(item, streamName, fallbackVideo) {
  const resolution = getResolutionLabel(item, fallbackVideo);
  const quality = String(item.qualityType || item.quality_type || "").trim();
  const codec = getCodecLabel(item, streamName);
  return [resolution || quality || "Default", codec].filter(Boolean).join(" ");
}

function extractThumbnailUrl(note) {
  const images = Array.isArray(note?.imageList)
    ? note.imageList
    : Array.isArray(note?.image_list)
      ? note.image_list
      : [];
  for (const image of images) {
    for (const value of [
      image?.urlDefault,
      image?.url_default,
      image?.urlPre,
      image?.url_pre,
      image?.url,
    ]) {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        return value;
      }
    }
  }
  return null;
}

function buildDirectHeaders(pageUrl, headers) {
  return {
    ...headers,
    Referer: pageUrl,
  };
}

function getMediaUrlKey(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}`;
  } catch {
    return value;
  }
}

export function extractRedNoteSourcesFromHtml(html, pageUrl, headers = REDNOTE_HEADERS) {
  const initialState = extractJsonAssignment(html, "window.__INITIAL_STATE__");
  const entry = pickRedNoteEntry(initialState, pageUrl);
  const note = entry.note;
  const mediaV2 = parseMediaV2(note?.video?.mediaV2 || note?.video?.media_v2);
  const directHeaders = buildDirectHeaders(pageUrl, headers);
  const sources = [];
  const seen = new Set();

  const addSource = (label, directUrl, alternateUrls = [], isOriginal = false) => {
    if (typeof directUrl !== "string" || !/^https?:\/\//i.test(directUrl)) return;
    const sourceKey = getMediaUrlKey(directUrl);
    if (seen.has(sourceKey)) return;
    seen.add(sourceKey);

    const validAlternates = alternateUrls.filter(
      (value) =>
        typeof value === "string" &&
        /^https?:\/\//i.test(value) &&
        value !== directUrl
    );

    sources.push({
      label,
      directUrl,
      alternateUrls: [...new Set(validAlternates)],
      headers: directHeaders,
      isOriginal,
    });
  };

  const addStreamGroups = (streamGroups, fallbackVideo = {}) => {
    if (!streamGroups || typeof streamGroups !== "object") return;

    for (const [streamName, formats] of Object.entries(streamGroups)) {
      if (!Array.isArray(formats)) continue;
      for (const item of formats) {
        if (!item || typeof item !== "object") continue;
        const masterUrl = item.masterUrl || item.master_url;
        const backupUrls = Array.isArray(item.backupUrls)
          ? item.backupUrls
          : Array.isArray(item.backup_urls)
            ? item.backup_urls
            : [];
        addSource(
          buildSourceLabel(item, streamName, fallbackVideo),
          masterUrl || backupUrls[0],
          masterUrl ? backupUrls : backupUrls.slice(1)
        );
      }
    }
  };

  addStreamGroups(note?.video?.media?.stream, note?.video?.media?.video);
  addStreamGroups(mediaV2?.video?.stream || mediaV2?.stream, mediaV2?.video);

  const originVideoKey =
    note?.video?.consumer?.originVideoKey ||
    note?.video?.consumer?.origin_video_key ||
    mediaV2?.video?.consumer?.originVideoKey ||
    mediaV2?.video?.consumer?.origin_video_key;
  if (
    typeof originVideoKey === "string" &&
    originVideoKey.trim()
  ) {
    addSource(
      "Original",
      `https://sns-video-bd.xhscdn.com/${originVideoKey.trim().replace(/^\/+/, "")}`,
      [],
      true
    );
  }

  if (sources.length === 0) {
    if (note?.type && note.type !== "video") {
      throw new Error("RedNote post is photo-only and does not contain a video stream.");
    }
    throw new Error("RedNote fallback found the post but no playable video URL.");
  }

  return {
    sources,
    thumbnailUrl: extractThumbnailUrl(note),
    noteId: note?.noteId || note?.note_id || extractRedNotePostId(pageUrl),
  };
}

function getAxiosResponseUrl(response, fallbackUrl) {
  return (
    response?.request?.res?.responseUrl ||
    response?.request?._currentUrl ||
    fallbackUrl
  );
}

export async function getRedNoteFallbackSources(
  inputUrl,
  finalUrl,
  {
    timeoutMs = 15000,
    logger = () => {},
    httpClient = axios,
  } = {}
) {
  // Desktop redirects can land on /explore with only target_note_id left.
  // Rebuild the mobile share path while retaining the signed query parameters.
  const candidates = [];
  for (const value of [finalUrl, inputUrl].filter(Boolean)) {
    if (
      isRedNoteUrl(value) &&
      extractRedNotePostId(value) &&
      !new URL(value).pathname.startsWith("/discovery/item/")
    ) {
      const mobileUrl = new URL(value);
      mobileUrl.pathname = `/discovery/item/${extractRedNotePostId(value)}`;
      if (mobileUrl.searchParams.has("target_note_id")) {
        mobileUrl.searchParams.delete("target_note_id");
        mobileUrl.searchParams.delete("undertake_note_error");
      }
      candidates.push(mobileUrl.href);
    }
    candidates.push(value);
  }
  let lastError = null;

  // Some public posts omit media on desktop but hydrate it on mobile.
  for (const headers of [REDNOTE_MOBILE_HEADERS, REDNOTE_HEADERS]) {
    for (const candidateUrl of new Set(candidates)) {
      try {
        logger(`[fallback] RedNote page parse start: ${candidateUrl}`);
        const response = await httpClient({
          method: "GET",
          url: candidateUrl,
          timeout: timeoutMs,
          maxRedirects: 10,
          headers,
          validateStatus: () => true,
        });

        if (response.status >= 400 || typeof response.data !== "string") {
          throw new Error(`RedNote fallback page fetch failed (status ${response.status}).`);
        }

        const pageUrl = getAxiosResponseUrl(response, candidateUrl);
        const extracted = extractRedNoteSourcesFromHtml(response.data, pageUrl, headers);
        logger(
          `[fallback] RedNote video URL extracted (${extracted.sources.length} source(s)).`
        );
        return {
          ...extracted,
          pageUrl,
        };
      } catch (error) {
        lastError = error;
        logger(`[fallback] RedNote candidate failed for ${candidateUrl}: ${error.message}`);
      }
    }
  }

  throw lastError || new Error("RedNote fallback could not extract a playable video.");
}
