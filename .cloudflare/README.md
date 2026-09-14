# Cloudflare production

Production URL: <https://gods.lily.lat>. Only `cf-production` deploys it.

## Architecture

The Worker serves the Vite production build through its `ASSETS` binding. HTML,
JavaScript, CSS, Cesium and bundled data never depend on a running container.
`run_worker_first` keeps the same routing/security policy on every asset and
prevents a public `workers.dev` asset entrance around Access.

`/api/*` goes through the single `GodsEyeViewContainer` Durable Object, named
`gods-eye-primary`, into a Node HTTP server on port 4173. The server installs
the upstream provider registry's `configurePreviewServer` hooks on Connect;
it does **not** run Vite preview or the Vite development server. All 19 current
provider plugins are installed. New providers without a production-compatible
hook fail startup/tests, requiring an explicit compatibility review.

The container remains `basic` (1/4 vCPU, 1 GiB RAM, 4 GB ephemeral disk), with
`max_instances = 1` and `sleepAfter = 30m`. The Node heap limit is 512 MiB.
One instance also preserves AISStream's single backend connection per key.
The runtime image contains Node, Connect, ws and upstream provider/source/config
files; it contains no Vite dependencies, HMR, browser build or credentials.
It runs as the unprivileged `node` user and handles SIGTERM gracefully.

There is no added KV, R2 or D1. Durable Object storage holds small lifecycle
counters. Provider caches and conversation debug files remain ephemeral and
are reset when the container is replaced or sleeps, as on Cloudflare Containers.
They are not a persistent archive.

## Credentials and provider availability

The GitHub deployment secrets are `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `CF_ACCESS_EMAIL`. The owner email is never committed.
`GEV_DEPLOY_PROBE_TOKEN` is generated in Actions, masked, and deployed as a Worker
secret with `wrangler deploy --secrets-file`. It is never passed to the container.
Each deployment rotates this diagnostic credential.

The deployment token also needs the independent account permission
`Access: Service Tokens Write` (Dashboard: Edit). The workflow verifies creation
and deletion with a five-minute token that is never authorized for any app,
before building or changing production. Zone `Bot Management Read` and
`Analytics Read` provide optional evidence about edge challenges. Worker logs
redact URL query strings.

Provider secrets can be added to the **gods-eye-view Worker** through Cloudflare
Secrets. `src/policy.js` is the runtime environment allowlist. A subsequent
deployment/container restart applies new values. Existing Worker secrets survive
deployments; `--keep-vars` also preserves Dashboard configuration variables.

| Provider | Runtime secret/configuration | Without credentials |
| --- | --- | --- |
| OpenSky | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, optional `OPENSKY_AUTH_MODE` | Anonymous mode and upstream ADS-B fallback |
| ADS-B / aircraft enrichment | None | Public providers, with their rate limits |
| AISStream | `AISSTREAM_API_KEY` | Explicit missing-key status / HTTP 503 |
| NASA FIRMS | `FIRMS_MAP_KEY` | Status available; fire data reports missing key |
| TomTom | `TOMTOM_API_KEY`, optional `TOMTOM_DAILY_TILE_BUDGET` | Built-in traffic simulation; live tiles report missing key |
| Google Places / Street View fallback | `GOOGLE_MAPS_SERVER_API_KEY` (or server-side `GOOGLE_MAPS_API_KEY`) | Places return keyless data; CCTV uses other fallbacks |
| OpenAI | `OPENAI_API_KEY`, optional `OPENAI_REALTIME_*` / `OPENAI_HUD_SUMMARY_MODEL` | Voice credentials report HTTP 503 |
| Launch Library | Optional `LL2_API_TOKEN` | Public allowance |
| TfL CCTV | Optional `TFL_APP_KEY` | Other CCTV sources remain available |
| Satellites / earthquakes / radio / terrain / Overpass / GBFS / regional data | None for public sources | Available subject to third-party availability |

Upstream's **Google photorealistic map** and **Cesium ion imagery/world terrain**
integrations use browser-visible credentials by design. This production build
does not inject `GOOGLE_MAPS_API_KEY` or `CESIUM_ION_TOKEN` into browser assets,
even if those names exist as Worker secrets. Keyless Esri/bundled map choices
remain available. Enabling the two browser-key integrations requires a separate,
explicit decision about restricted public credentials or a dedicated tile proxy;
adding a private secret alone cannot safely enable those browser integrations.

The local POWER UP endpoint, which writes `.env` and restarts Vite, is excluded
from production. All other provider hooks are retained. Default server-side
cost guards are 20 OpenAI and 60 Google requests per minute; upstream's guard
uses the socket peer, so behind the container proxy this is a conservative
shared quota, not a guaranteed per-user quota. Configure provider billing caps
separately if paid providers are enabled.

## Access and realtime

Use a **hostname-based Self-hosted Access application** for `gods.lily.lat`,
allowing only the email in `CF_ACCESS_EMAIL` through One-time PIN. Do not replace
it with Worker-level Access: Cloudflare currently documents a WebSocket
limitation for Worker-level policies.

The public workers.dev URL redirects to the custom domain. `/__ops/*` on either
host additionally requires `X-GEV-Probe-Token`; normal API requests cannot select
a different container port. Access cookies, Access service credentials and
deployment probe credentials are stripped before forwarding to providers.

OpenAI's actual flow is browser -> same-origin token API -> OpenAI WebRTC.
AIS's actual flow is container -> AISStream WebSocket, with browser JSON polling.
Neither requires a browser-facing application WebSocket. The bounded
`/__ops/ws` and same-origin `/__transport/ws` echoes check **transport only**,
through Access -> Worker -> Container. The Chromium test uses its Access cookie
for the actual browser WebSocket handshake.
It does not claim successful OpenAI audio or authenticated AIS data without keys.

CI creates a one-hour Access service token and an application-scoped Service Auth
policy for each verification run, then removes both in `finally`. Browser tests
attach these credentials only to the exact production origin. A cancelled job
can leave a temporary policy; its token expires within one hour. Remove stale
`gods-eye-ci-*` tokens/policies in Access if a job was forcibly cancelled.

## Deployment and diagnosis

Push to `cf-production` runs upstream tests, adapter tests, a secret-free browser
build, asset-size checks, Wrangler dry-run, a Docker build, and HTTP/WebSocket
tests under 1 GiB / 0.25 CPU before any production mutation. It then checks the
existing account/zone/Worker, deploys via Wrangler, validates the production
revision, configures/verifies Access, runs 20 sequential home requests plus
concurrency/static/API tests, and launches a real Chromium browser.

Set the repository variable `CF_LIFECYCLE_TEST=true` to additionally exercise
a controlled production stop/wake and verify that static assets stay available
while the container is stopped. This deliberately interrupts active APIs;
leave it `false` for routine deployments after migration acceptance.

Download the `cloudflare-evidence-<SHA>` Actions artifact for sanitized runtime,
infrastructure, HTTP, browser screenshot and lifecycle evidence. Provider errors
are distinct from SDK transport failures. Readiness polls are bounded and logged;
acceptance requests are never retried to hide failures. There is no automatic
rollback or blind retry of API requests that might spend quota.

Local validation (Node 24.14+):

```sh
npm ci
npm ci --prefix .cloudflare
npm ci --prefix .cloudflare/runtime
npm test
node --test .cloudflare/tests/*.test.mjs
npm run build -- --config .cloudflare/vite.config.mjs
node .cloudflare/scripts/validate-build.mjs
docker build -f Dockerfile.cloudflare -t gods-eye-view-test .
```

On macOS, upstream tests that compare temporary paths may need
`TMPDIR=/private/tmp npm test`. On hosts without Docker, a Worker-only local
dry-run can use `--containers-rollout none`; the Actions Docker tests remain
mandatory. This option is never used for a production deployment.

## Following upstream

`main` is the upstream mirror; it has no production deployment trigger. Keep the
Cloudflare adapter changes on `cf-production`. Inspect clean worktrees and active
Git operations before switching branches; preserve unfinished work.

```sh
git fetch origin --prune
git fetch upstream --prune
git switch main
git merge --ff-only upstream/main
git push origin main
git switch cf-production
git merge main
# Review any upstream/provider changes, resolve conflicts, run validation.
git push origin cf-production
```

If `main` cannot fast-forward, stop and inspect the graph instead of resetting,
rebasing or force-pushing it. This migration does not modify `main`. Merging new
upstream work into production should remain an explicit, reviewed maintenance
operation; the adapter shares upstream implementation rather than copying its
provider logic.

References: [Vite production guidance](https://vite.dev/guide/static-deploy),
[Container limits](https://developers.cloudflare.com/containers/platform/limits/),
[Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/),
[Access and WebSockets](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
