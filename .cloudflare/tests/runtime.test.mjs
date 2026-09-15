import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from '../runtime/node_modules/ws/wrapper.mjs';
import { createProductionServer } from '../runtime/server.mjs';
import {
  containerEnvironment,
  probeAuthorized,
  proxyRequest,
} from '../src/policy.js';

test('production provider routes preserve status, keyless and prefix semantics', async () => {
  const runtime = await createProductionServer();
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const health = await (await fetch(`${base}/__health`)).json();
    assert.equal(health.server, 'node-production');
    assert.match(health.imageRevision, /^(?:local|[a-f0-9]{40})$/);
    const previousRevision = process.env.GEV_REVISION;
    try {
      process.env.GEV_REVISION = 'new-worker-old-image';
      const mismatched = await (await fetch(`${base}/__health`)).json();
      assert.equal(mismatched.revision, 'new-worker-old-image');
      assert.equal(mismatched.imageRevision, health.imageRevision);
    } finally {
      if (previousRevision === undefined) delete process.env.GEV_REVISION;
      else process.env.GEV_REVISION = previousRevision;
    }
    assert.equal(health.providers.length, 19);
    const checks = [
      ['/api/tomtom/status', 200],
      ['/api/firms/status', 200],
      ['/api/terrain/heights', 400],
      ['/api/tomtom/missing', 404],
      ['/api/no-such-provider', 404],
      ['/api/setup/keys', 404, 'POST'],
      ['/api/google/nearby-places', 200],
      ['/api/realtime/token', 405, 'DELETE'],
      ['/api/realtime/token', 503],
      ['/api/ais-live', 503],
      ['/api/ais-live/track', 400],
      ['/api/firms', 503],
    ];
    for (const [path, status, method = 'GET'] of checks) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, status, path);
      assert.match(response.headers.get('content-type'), /json/);
      await response.text();
    }
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${base}/__health`).then((r) => r.json()),
      ),
    );
    assert.ok(responses.every((body) => body.bootId === health.bootId));
    assert.equal(responses.at(-1).responseStatuses[405], 1);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/__health/ws');
    await once(ws, 'open');
    ws.send('transport-probe');
    assert.equal((await once(ws, 'message'))[0].toString(), 'transport-probe');
    ws.close();
    await once(ws, 'close');
    const finalHealth = await (await fetch(`${base}/__health`)).json();
    assert.equal(finalHealth.websockets.accepted, 1);
    assert.equal(finalHealth.websockets.rejected, 0);
    for (const status of [405, 406]) {
      const response = await fetch(`${base}/__health/status-code/${status}`);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('x-gev-server'), 'node-production');
      assert.deepEqual(await response.json(), {
        error: 'diagnostic_status',
        status,
      });
    }
    assert.equal((await fetch(`${base}/__health/status-code/201`)).status, 404);
  } finally {
    await runtime.close();
  }
});

test('async provider rejection is contained; subsequent requests remain healthy', async () => {
  const runtime = await createProductionServer({
    plugins: [
      {
        name: 'async-fixture',
        configurePreviewServer({ middlewares }) {
          middlewares.use('/api/reject', async () => {
            throw new Error('private provider error');
          });
          middlewares.use('/api/mount', (req, res) => {
            res.end(req.url);
          });
        },
      },
    ],
  });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const failed = await fetch(base + '/api/reject');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'provider_handler_error' });
    assert.equal(
      await (await fetch(base + '/api/mount/sub?q=1')).text(),
      '/sub?q=1',
    );
    assert.equal((await fetch(base + '/__health')).status, 200);
  } finally {
    await runtime.close();
  }
});

test('secrets and proxy control headers do not reach provider request or browser config', () => {
  const env = containerEnvironment({
    OPENAI_API_KEY: 'private',
    CLOUDFLARE_API_TOKEN: 'deploy',
    GEV_DEPLOY_PROBE_TOKEN: 'probe',
  });
  assert.equal(env.OPENAI_API_KEY, 'private');
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(env.GEV_DEPLOY_PROBE_TOKEN, undefined);
  assert.equal(env.OPENSKY_AUTH_MODE, 'anon');
  const token = 'a'.repeat(64);
  assert.equal(
    probeAuthorized(new Request('https://gods.lily.lat/__ops/health'), {
      GEV_DEPLOY_PROBE_TOKEN: token,
    }),
    false,
  );
  const request = new Request('https://gods.lily.lat/api/realtime/token', {
    method: 'POST',
    body: 'test',
    headers: {
      'x-gev-probe-token': token,
      'cf-container-target-port': '9999',
      cookie: 'private',
      'cf-access-client-secret': 'private',
    },
  });
  assert.equal(
    probeAuthorized(request, { GEV_DEPLOY_PROBE_TOKEN: token }),
    true,
  );
  const forwarded = proxyRequest(request);
  for (const key of [
    'x-gev-probe-token',
    'cf-container-target-port',
    'cookie',
    'cf-access-client-secret',
  ])
    assert.equal(forwarded.headers.has(key), false);
});
