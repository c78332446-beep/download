export function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3010\u3011\u300A\u300B\uFF08\uFF09]+/gi) || [];
  const urls = matches.map((value) => value
    .replace(/[)\]},.!?\u201D\u2019]+$/g, "")
    .replace(/^(https?:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+\/)[^?#].*$/i, "$1"));
  return [...new Set(urls)];
}
