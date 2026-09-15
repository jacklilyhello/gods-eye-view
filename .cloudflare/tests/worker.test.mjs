import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['.cloudflare/src/index.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  plugins: [
    {
      name: 'container-test-double',
      setup(plugin) {
        plugin.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({
          path: 'container',
          namespace: 'test',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export class Container {} export const getContainer = (binding) => binding;',
        }));
      },
    },
  ],
});
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

test('static serving is independent of container availability and protects workers.dev', async () => {
  const env = {
    GEV_REVISION: 'tested-revision',
    ASSETS: {
      fetch: async () =>
        new Response('<html>built</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    },
  };
  const response = await worker.fetch(
    new Request('https://gods.lily.lat/'),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gev-revision'), 'tested-revision');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const redirected = await worker.fetch(
    new Request('https://gods-eye-view.lilyya.workers.dev/api/realtime/token'),
    env,
  );
  assert.equal(redirected.status, 308);
  assert.equal(
    redirected.headers.get('location'),
    'https://gods.lily.lat/api/realtime/token',
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://gods.lily.lat/', { method: 'POST' }),
        env,
      )
    ).status,
    405,
  );
});

test('deployment operations require a separate token and strip all proxy credentials', async () => {
  const token = 'b'.repeat(64);
  const calls = [];
  const env = {
    GEV_DEPLOY_PROBE_TOKEN: token,
    GODS_EYE: {
      fetch: async (request) => {
        calls.push(request);
        return new Response('healthy');
      },
    },
  };
  assert.equal(
    (await worker.fetch(new Request('https://gods.lily.lat/__ops/health'), env))
      .status,
    404,
  );
  assert.equal(calls.length, 0);
  const headers = {
    'x-gev-probe-token': token,
    'cf-container-target-port': '9000',
    'cf-access-client-secret': 'sensitive',
  };
  const response = await worker.fetch(
    new Request('https://gods.lily.lat/__ops/health', { headers }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(new URL(calls[0].url).pathname, '/__health');
  assert.ok(!calls[0].headers.has('cf-container-target-port'));
  assert.ok(!calls[0].headers.has('x-gev-probe-token'));
  assert.ok(!calls[0].headers.has('cf-access-client-secret'));
  for (const status of [405, 406]) {
    const url = `https://gods.lily.lat/__ops/status-code/${status}`;
    const before = calls.length;
    assert.equal((await worker.fetch(new Request(url), env)).status, 404);
    assert.equal(calls.length, before);
    await worker.fetch(new Request(url, { headers }), env);
    assert.equal(
      new URL(calls.at(-1).url).pathname,
      `/__health/status-code/${status}`,
    );
    assert.ok(!calls.at(-1).headers.has('x-gev-probe-token'));
    assert.equal(
      (await worker.fetch(new Request(url, { headers, method: 'POST' }), env))
        .status,
      404,
    );
  }
  assert.equal(
    (
      await worker.fetch(
        new Request('https://gods.lily.lat/__ops/status-code/201', { headers }),
        env,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://gods.lily.lat/__health/status-code/406'),
        env,
      )
    ).status,
    404,
  );
});
