import fs from "node:fs";
import { unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import axios from "axios";

function tooLarge(maxBytes) {
  return Object.assign(new Error(`Media exceeds the configured download limit (${(maxBytes / 1024 / 1024).toFixed(2)} MB).`), {
    code: "MEDIA_TOO_LARGE",
  });
}

export async function downloadDirectFile(url, filePath, headers, {
  maxBytes = Infinity,
  httpClient = axios,
} = {}) {
  const response = await httpClient({
    method: "GET", url, responseType: "stream", timeout: 60000, headers,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const contentType = String(response.headers?.["content-type"] || "");
  if (/(?:text\/|json|xml|javascript)/i.test(contentType)) {
    response.data.destroy();
    throw new Error("Direct media URL returned a web page instead of a video. The media link may be blocked or expired.");
  }
  if (Number(response.headers?.["content-length"]) > maxBytes) {
    response.data.destroy();
    throw tooLarge(maxBytes);
  }
  let bytes = 0;
  const validate = new Transform({
    transform(chunk, encoding, callback) {
      if (bytes === 0 && /^\s*(?:<!doctype|<html|<script|<head|<body|\{|\[)/i.test(chunk.toString("utf8", 0, 256))) {
        callback(new Error("Direct media URL returned a web page instead of a video. The media link may be blocked or expired."));
        return;
      }
      bytes += chunk.length;
      callback(bytes > maxBytes ? tooLarge(maxBytes) : null, chunk);
    },
    flush(callback) {
      callback(bytes === 0 ? new Error("Direct media URL returned an empty video.") : null);
    },
  });
  try {
    await pipeline(response.data, validate, fs.createWriteStream(filePath));
  } catch (error) {
    await unlink(filePath).catch(() => {});
    throw error;
  }
}
