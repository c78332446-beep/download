import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { extractDouyinSources } from "./douyin.js";

let extractionQueue = Promise.resolve();
let guestSession;

function findChromium(executablePath) {
  const candidates = [
    executablePath,
    process.env.CHROMIUM_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function browserProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}),
  };
}

async function extractWithBrowser(videoId, {
  timeoutMs = 40000,
  logger = () => {},
  executablePath,
  proxyUrl = "",
  browserType = chromium,
} = {}) {
  if (!/^\d+$/.test(videoId || "")) throw new Error("Douyin browser fallback requires a video ID.");
  const pageUrl = `https://www.douyin.com/video/${videoId}`;
  const navigationUrl = () => `${pageUrl}?previous_page=app_code_link&_=${Date.now()}`;
  logger(`[fallback] Opening Douyin video ${videoId} in an isolated browser.`);
  const browser = await browserType.launch({
    executablePath: findChromium(executablePath),
    channel: process.platform === "win32" ? "chrome" : "chromium",
    headless: true,
    chromiumSandbox: false,
    args: ["--disable-dev-shm-usage"],
    proxy: browserProxy(proxyUrl),
    timeout: timeoutMs,
  });
  let timer;
  let playerTimer;
  let retryTimer;
  try {
    const context = await browser.newContext(guestSession ? { storageState: guestSession } : {});
    const page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const headers = { "User-Agent": userAgent, Referer: "https://www.douyin.com/", Accept: "*/*" };
    const result = new Promise((resolve, reject) => {
      let retried = false;
      const navigate = () => {
        void page.goto(navigationUrl(), { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch((error) => {
          reject(new Error(`Douyin browser navigation failed: ${error.message}`));
        });
      };
      timer = setTimeout(() => reject(new Error("Douyin browser did not provide video data before the timeout. The video may be unavailable or require a session.")), timeoutMs);
      // Current players also identify their source URLs with the exact post ID.
      playerTimer = setInterval(async () => {
        try {
          const sources = await page.evaluate((expectedId) => {
            const seen = new Set();
            return [...document.querySelectorAll("video source[src], video[src]")].flatMap((element) => {
              const directUrl = element.src;
              if (!directUrl || seen.has(directUrl)) return [];
              const url = new URL(directUrl, location.href);
              if (!["https:", "http:"].includes(url.protocol) || url.searchParams.get("__vid") !== expectedId) return [];
              seen.add(directUrl);
              const video = element.closest("video");
              const dimensions = [video?.videoWidth, video?.videoHeight].filter((value) => value > 0);
              return [{ label: dimensions.length ? `${Math.min(...dimensions)}p` : "Browser", directUrl }];
            });
          }, videoId);
          if (Array.isArray(sources) && sources.length) {
            resolve({ videoId, pageUrl, thumbnailUrl: null, sources: sources.map((source) => ({ ...source, headers })) });
          }
        } catch {
          // A navigation can replace the document between polling ticks.
        }
      }, 750);
      page.on("response", async (response) => {
        try {
          const url = new URL(response.url());
          if (!/^(?:www\.)?(?:douyin|iesdouyin)\.com$/.test(url.hostname) ||
              !["/aweme/v1/web/aweme/detail/", "/web/api/v2/aweme/iteminfo/"].includes(url.pathname)) return;
          if (!response.ok()) {
            if (response.status() === 403 && !retried) {
              retried = true;
              logger("[fallback] Douyin is initializing its guest session; retrying the watch page once.");
              retryTimer = setTimeout(navigate, 1500);
            }
            return;
          }
          const data = await response.json();
          // Recommendation requests must never supply a different video.
          const extracted = extractDouyinSources(data, pageUrl, headers);
          resolve(extracted);
        } catch (error) {
          if (/photo-only/.test(error.message)) reject(error);
          else logger(`[fallback] Douyin browser response skipped: ${error.message}`);
        }
      });
      navigate();
    });
    const extracted = await result;
    guestSession = await context.storageState();
    logger(`[fallback] Douyin browser extracted video ${videoId} (${extracted.sources.length} source(s)).`);
    return extracted;
  } catch (error) {
    guestSession = undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(playerTimer);
    clearTimeout(retryTimer);
    await browser.close();
  }
}

// A single Chromium extraction at a time bounds memory on small cloud workers.
export function getDouyinBrowserSources(videoId, options = {}) {
  const extraction = extractionQueue.then(() => extractWithBrowser(videoId, options));
  extractionQueue = extraction.catch(() => {});
  return extraction;
}
