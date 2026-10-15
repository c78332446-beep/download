import axios from "axios";

function getResponseUrl(response, fallbackUrl) {
  return (
    response?.request?.res?.responseUrl ||
    response?.request?._currentUrl ||
    response?.config?.url ||
    fallbackUrl
  );
}

function isUsableResponse(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

export async function resolveFinalUrl(
  inputUrl,
  {
    headers = {},
    timeoutMs = 15000,
    skipHead = false,
    logger = () => {},
    httpClient = axios,
  } = {}
) {
  logger(`[resolve] Start: ${inputUrl}`);

  if (!skipHead) {
    try {
      const headResponse = await httpClient({
        method: "HEAD",
        url: inputUrl,
        maxRedirects: 10,
        timeout: timeoutMs,
        validateStatus: () => true,
        headers,
      });

      const finalUrl = getResponseUrl(headResponse, inputUrl);
      logger(`[resolve] HEAD result: ${finalUrl} (status ${headResponse.status})`);
      if (isUsableResponse(headResponse.status)) {
        return finalUrl;
      }

      logger(`[resolve] HEAD status ${headResponse.status} is not usable; trying GET.`);
    } catch (error) {
      logger(`[resolve] HEAD failed: ${error.message}`);
    }
  } else {
    logger("[resolve] Skipping HEAD because this platform returns false negatives.");
  }

  try {
    const getResponse = await httpClient({
      method: "GET",
      url: inputUrl,
      maxRedirects: 10,
      timeout: timeoutMs,
      validateStatus: () => true,
      headers,
      responseType: "stream",
    });

    const finalUrl = getResponseUrl(getResponse, inputUrl);
    getResponse.data?.destroy?.();
    logger(`[resolve] GET result: ${finalUrl} (status ${getResponse.status})`);

    if (isUsableResponse(getResponse.status)) {
      return finalUrl;
    }

    logger(`[resolve] GET status ${getResponse.status} is not usable; keeping original URL.`);
  } catch (error) {
    logger(`[resolve] GET failed, keeping original URL: ${error.message}`);
  }

  return inputUrl;
}
