import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { WebSocket } from '../runtime/node_modules/ws/wrapper.mjs';

export async function check(
  base,
  path,
  status,
  { headers = {}, method = 'GET', revision, timeout = 30000 } = {},
) {
  const start = Date.now();
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.text();
  const row = {
    path,
    method,
    status: response.status,
    ms: Date.now() - start,
    bytes: Buffer.byteLength(body),
  };
  console.log(JSON.stringify(row));
  assert.equal(response.status, status, `${method} ${path}`);
  assert.ok(!body.includes('Container suddenly disconnected'), path);
  if (revision && status === 200)
    assert.equal(
      response.headers.get('x-gev-revision'),
      revision,
      `revision ${path}`,
    );
  return { row, body, response };
}

export async function websocketProbe(base, path, headers = {}) {
  await new Promise((resolve, reject) => {
    const url = new URL(path, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { headers, handshakeTimeout: 20000 });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket probe timed out'));
    }, 25000);
    ws.on('open', () => ws.send('gods-eye-transport-probe'));
    ws.on('message', (data) => {
      if (data.toString() !== 'gods-eye-transport-probe') {
        ws.terminate();
        reject(new Error('WebSocket echo mismatch'));
        return;
      }
      ws.close(1000);
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      code === 1000 ? resolve() : reject(new Error(`WebSocket close ${code}`));
    });
  });
  console.log(JSON.stringify({ websocket: path, result: 'echo_pass' }));
}

export async function smoke({
  base,
  headers = {},
  revision,
  apiOnly = false,
} = {}) {
  const rows = [];
  const run = async (path, status, method = 'GET') => {
    const result = await check(base, path, status, {
      headers,
      method,
      revision,
    });
    rows.push(result.row);
    return result;
  };
  if (!apiOnly) {
    let html;
    for (let i = 0; i < 20; i++) html = (await run('/', 200)).body;
    assert.ok(
      !html.includes('/@vite/client') && !html.includes('/src/main.js'),
      'HTML must be built',
    );
    const assets = new Set(
      [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(
        (m) => m[1],
      ),
    );
    assert.ok(
      [...assets].some((path) => path.includes('/assets/')),
      'built JS/CSS present',
    );
    for (const asset of assets) {
      const { response, body } = await run(asset, 200);
      assert.ok(
        !response.headers.get('content-type')?.includes('text/html'),
        asset,
      );
      assert.ok(body.length > 0, asset);
    }
    const texture = '/cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg';
    await run(texture, 200);
    await Promise.all(Array.from({ length: 12 }, () => run('/', 200)));
    for (const path of [
      '/api/no-such-provider',
      '/.env',
      '/.git/config',
      '/src/main.js',
      '/@vite/client',
      '/__health',
    ])
      await run(path, 404);
    await run('/', 405, 'POST');
  }
  for (const [path, status, method] of [
    ['/api/tomtom/status', 200],
    ['/api/firms/status', 200],
    ['/api/terrain/heights', 400],
    ['/api/tomtom/missing', 404],
    ['/api/no-such-provider', 404],
    ['/api/realtime/token', 405, 'DELETE'],
    ['/api/google/nearby-places', 405, 'POST'],
    ['/api/setup/keys', 404, 'POST'],
    ['/api/ais-live/track', 400],
  ])
    await run(path, status, method);
  // Inspect key availability before testing missing-key responses: never mint
  // paid sessions or use a credential merely to make the smoke test pass.
  const tomtom = await run('/api/tomtom/status', 200);
  if (!JSON.parse(tomtom.body).hasKey)
    await run('/api/tomtom/flow/0/0/0.pbf', 503);
  const firms = await run('/api/firms/status', 200);
  if (!JSON.parse(firms.body).hasKey) await run('/api/firms', 503);
  return rows;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = process.argv[2] || 'http://127.0.0.1:4173';
  await smoke({ base, apiOnly: process.argv.includes('--api-only') });
  if (process.argv.includes('--api-only'))
    await websocketProbe(base, '/__health/ws');
}
