import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  api,
  list,
  inspect,
  evidence,
  accountPath,
  domain,
} from './cloudflare-api.mjs';
import { check, smoke, websocketProbe } from './smoke.mjs';
import { browserSmoke } from './browser-smoke.mjs';
import { providerProbes } from './provider-probes.mjs';

const base = `https://${domain}`;
const diagnosticBase = 'https://gods-eye-view.lilyya.workers.dev';
const probeHeaders = {
  'x-gev-probe-token': process.env.GEV_DEPLOY_PROBE_TOKEN,
};
const revision = process.env.GITHUB_SHA;

async function ready() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const { body } = await check(diagnosticBase, '/__ops/health', 200, {
        headers: probeHeaders,
        timeout: 30000,
      });
      const health = JSON.parse(body);
      if (health.server === 'node-production' && health.revision === revision)
        return health;
    } catch (error) {
      console.log(
        JSON.stringify({ readinessAttempt: attempt, error: error.name }),
      );
    }
    await delay(5000);
  }
  throw new Error('New production revision did not become ready');
}

async function ensureAccess(existing) {
  const email = process.env.CF_ACCESS_EMAIL;
  assert.match(
    email || '',
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    'CF_ACCESS_EMAIL is required',
  );
  if (existing) {
    const policies = await list(
      `${accountPath}/access/apps/${existing.id}/policies`,
    );
    const allow = policies.filter((p) => p.decision === 'allow');
    assert.ok(
      allow.length === 1 &&
        allow[0].include?.length === 1 &&
        allow[0].include[0].email?.email === email &&
        !allow[0].exclude?.length &&
        !allow[0].require?.length,
      'Existing Access allow policy differs from requested owner',
    );
    assert.ok(
      !policies.some((p) => p.decision === 'bypass'),
      'Access bypass policy is not permitted',
    );
    return existing;
  }
  const providers = await list(`${accountPath}/access/identity_providers`);
  let otp = providers.find((p) => p.type === 'onetimepin');
  if (!otp)
    otp = await api(`${accountPath}/access/identity_providers`, {
      method: 'POST',
      body: { name: 'One-time PIN', type: 'onetimepin', config: {} },
    });
  return api(`${accountPath}/access/apps`, {
    method: 'POST',
    body: {
      name: 'Gods Eye View Production',
      domain,
      type: 'self_hosted',
      session_duration: '24h',
      allowed_idps: [otp.id],
      auto_redirect_to_identity: false,
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
      policies: [
        {
          name: 'Production owner',
          decision: 'allow',
          include: [{ email: { email } }],
          exclude: [],
          require: [],
        },
      ],
    },
  });
}

let token;
let policy;
let app;
try {
  const initialHealth = await ready();
  await evidence('runtime-before', initialHealth);
  const runtimeSamples = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const { body, row } = await check(diagnosticBase, '/__ops/health', 200, {
      headers: probeHeaders,
    });
    const sample = JSON.parse(body);
    assert.equal(
      sample.bootId,
      initialHealth.bootId,
      'Stable Node process before Access verification',
    );
    runtimeSamples.push({
      ...row,
      bootId: sample.bootId,
      rss: sample.memory.rss,
      uptimeSeconds: sample.uptimeSeconds,
    });
  }
  await websocketProbe(diagnosticBase, '/__ops/ws', probeHeaders);
  await evidence('runtime-transport', {
    samples: runtimeSamples,
    websocket: 'Worker + Container passed; Access tested separately',
  });
  const apps = await list(`${accountPath}/access/apps`);
  app = await ensureAccess(
    apps.find((candidate) => candidate.domain === domain),
  );
  await evidence('access-application', {
    id: app.id,
    domain: app.domain,
    type: app.type,
    ownerPolicy: true,
  });
  // A newly created Custom Domain can need DNS/TLS propagation. Keep these
  // readiness attempts distinct from the 20 no-retry acceptance requests.
  for (let attempt = 0; attempt < 36; attempt++) {
    try {
      const response = await fetch(base, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      await response.arrayBuffer();
      if (
        (response.status === 200 &&
          response.headers.get('x-gev-revision') === revision) ||
        (response.status === 302 &&
          new URL(response.headers.get('location')).hostname.endsWith(
            '.cloudflareaccess.com',
          )) ||
        (response.status === 403 &&
          response.headers.get('cf-mitigated') === 'challenge')
      )
        break;
      if (attempt === 35) throw new Error('Custom Domain readiness failed');
    } catch (error) {
      console.log(
        JSON.stringify({
          domainReadinessAttempt: attempt + 1,
          error: error.name,
        }),
      );
      if (attempt === 35) throw error;
    }
    await delay(5000);
  }
  // A challenge proves only DNS/TLS readiness. Authenticated HTTP 200 and the
  // exact deployed revision are still mandatory in the acceptance tests below.
  token = await api(`${accountPath}/access/service_tokens`, {
    method: 'POST',
    body: {
      name: `gods-eye-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
      duration: '1h',
    },
  });
  console.log(`::add-mask::${token.client_id}`);
  console.log(`::add-mask::${token.client_secret}`);
  policy = await api(`${accountPath}/access/apps/${app.id}/policies`, {
    method: 'POST',
    body: {
      name: `CI smoke ${process.env.GITHUB_RUN_ID}`,
      decision: 'non_identity',
      include: [{ service_token: { token_id: token.id } }],
      exclude: [],
      require: [],
    },
  });
  const accessHeaders = {
    'CF-Access-Client-Id': token.client_id,
    'CF-Access-Client-Secret': token.client_secret,
  };
  // Configuration propagation is separate from the no-retry acceptance tests.
  for (let attempt = 0; attempt < 24; attempt++) {
    const r = await fetch(base, {
      headers: accessHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    await r.arrayBuffer();
    if (r.status === 200) break;
    console.log(
      JSON.stringify({
        accessReadinessAttempt: attempt + 1,
        status: r.status,
        mitigation: r.headers.get('cf-mitigated'),
      }),
    );
    if (attempt === 23)
      throw new Error(`Access service authentication HTTP ${r.status}`);
    await delay(5000);
  }
  const unauthenticated = await fetch(base, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    unauthenticated.status,
    302,
    'Unauthenticated users must see Access login',
  );
  assert.ok(
    new URL(unauthenticated.headers.get('location')).hostname.endsWith(
      '.cloudflareaccess.com',
    ),
  );
  await unauthenticated.arrayBuffer();
  const rows = await smoke({ base, headers: accessHeaders, revision });
  await evidence('http-smoke', rows);
  const settings = await api(
    `${accountPath}/workers/scripts/gods-eye-view/settings`,
  );
  await providerProbes(
    base,
    accessHeaders,
    (settings.bindings || [])
      .filter((b) => b.type === 'secret_text')
      .map((b) => b.name),
  );
  await websocketProbe(base, '/__ops/ws', {
    ...accessHeaders,
    ...probeHeaders,
  });
  const browser = await browserSmoke(base, accessHeaders);
  const healthResults = await Promise.all(
    Array.from({ length: 20 }, async () =>
      JSON.parse(
        (
          await check(diagnosticBase, '/__ops/health', 200, {
            headers: probeHeaders,
          })
        ).body,
      ),
    ),
  );
  assert.ok(
    healthResults.every((health) => health.bootId === initialHealth.bootId),
    'Container must not restart during normal acceptance traffic',
  );
  if (process.env.CF_LIFECYCLE_TEST === 'true') {
    await check(diagnosticBase, '/__ops/stop', 200, {
      headers: probeHeaders,
      method: 'POST',
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = JSON.parse(
        (
          await check(diagnosticBase, '/__ops/status', 200, {
            headers: probeHeaders,
          })
        ).body,
      );
      if (status.state.status === 'stopped') break;
      if (attempt === 19)
        throw new Error('Container failed to stop gracefully');
      await delay(1000);
    }
    // Static Assets remain available while the container is stopped.
    await check(base, '/', 200, { headers: accessHeaders, revision });
    const restarted = await ready();
    assert.notEqual(
      restarted.bootId,
      initialHealth.bootId,
      'Lifecycle test requires a new Node process',
    );
    await evidence('runtime-after-restart', restarted);
    await check(base, '/api/tomtom/status', 200, {
      headers: accessHeaders,
      revision,
    });
    await websocketProbe(base, '/__ops/ws', {
      ...accessHeaders,
      ...probeHeaders,
    });
  }
  const finalHealth = await ready();
  await evidence('runtime-final', finalHealth);
  const lifecycle = JSON.parse(
    (
      await check(diagnosticBase, '/__ops/status', 200, {
        headers: probeHeaders,
      })
    ).body,
  );
  await evidence('lifecycle', lifecycle);
  const infrastructure = await inspect('infrastructure-after');
  assert.ok(infrastructure.report.domains.some((d) => d.hostname === domain));
  await evidence('acceptance', {
    revision,
    completedAt: new Date().toISOString(),
    homepageRequests: 20,
    access: {
      type: app.type,
      domain: app.domain,
      ownerPolicy: true,
      unauthenticatedStatus: 302,
      serviceAuth: true,
    },
    websocket: 'Access + Worker + Container echo passed; synthetic probe',
    browser,
    lifecycleTest: process.env.CF_LIFECYCLE_TEST === 'true',
  });
} finally {
  try {
    if (policy && app)
      await api(`${accountPath}/access/apps/${app.id}/policies/${policy.id}`, {
        method: 'DELETE',
      });
  } finally {
    if (token)
      await api(`${accountPath}/access/service_tokens/${token.id}`, {
        method: 'DELETE',
      });
  }
}
