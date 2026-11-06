# Deploy the Telegram downloader on Railway

Use the **download** service connected to this GitHub repository. The
`function-bun` service in the dashboard runs a separate Railway Functions
image; deploying it does not update this bot. The bot needs the repository's
Dockerfile, which installs FFmpeg, Chromium, and yt-dlp and starts `node index.js`.

## Enable automatic deployments

1. Open **download → Settings → Source**.
2. Confirm the repository is `c78332446-beep/download` and the branch is `main`.
3. If the page says **Auto deploy is disabled**, click **Enable**.
4. Enable **Wait for CI** to wait for this repository's **Validate downloader**
   GitHub Actions workflow. It runs the syntax checks and offline download tests
   on every push to `main` and on pull requests.
5. Press **Ctrl + K** and choose **Deploy Latest Commit** to deploy the current
   update. Open **Deployments** and check the build and startup logs.

Automatic deployment is a Railway service setting and must be enabled on the
connected service. Adding a workflow or editing `railway.json` alone does not
enable it. The **Redeploy** action on an old deployment reuses that deployment's
code; use **Deploy Latest Commit** to pick up a new push.

Railway documents these controls in
[GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys) and
[deployment actions](https://docs.railway.com/deployments/deployment-actions).

## Runtime variables and verification

Set `BOT_TOKEN` in **download → Variables**. Keep `AUTO_DOWNLOAD=true` and
`BOT_POLLING_ENABLED=true` on the hosted worker. Local `.env` values are not
uploaded by the Docker build. Only one worker should poll each bot token; disable
local polling when using the hosted service.

The Docker build runs `npm run build` before creating the final worker image.
Startup logs print `BUILD_REVISION`; confirm it matches the GitHub commit being
deployed. Then send a public video share link to the bot and check that a video,
rather than only its preview, is returned.

## Download recovery

RedNote downloads prefer the original asset, then try the available playback
qualities and their CDN backups if it is blocked. If every cached stream fails,
the bot refreshes the share page once and retries the newly extracted sources.
Audio and later HD downloads reuse the working stream. Failed manual downloads
keep their buttons usable until the selection expires.

Some playback streams include platform branding. Private, removed, login-only,
region-restricted, and oversized videos can still fail. A successful build or
deployment does not establish that a particular post is accessible from the
server; test its original share link after deployment.
