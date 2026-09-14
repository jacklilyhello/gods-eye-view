import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'gev-edge-test-'));
process.env.GEV_EVIDENCE_DIR = temporary;
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-only-token';
const { ensureEdgeAccess } = await import('../scripts/ensure-edge-access.mjs');
after(() => rm(temporary, { recursive: true }));

const app = { id: 'test-app', domain: 'gods.lily.lat', type: 'self_hosted' };
function fixture(t, { bypass = false, existing = false } = {}) {
  const rules = [
    {
      id: 'existing-block',
      action: 'block',
      expression: 'ip.src eq 192.0.2.1',
      enabled: true,
    },
  ];
  if (existing)
    rules.push({
      ref: 'gods_eye_access_transport',
      action: 'skip',
      expression: 'true',
    });
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    let result;
    if (pathname.endsWith('/policies'))
      result = [{ decision: bypass ? 'bypass' : 'allow' }];
    else if (pathname.endsWith('/zones'))
      result = [{ id: 'test-zone', account: { id: 'test-account' } }];
    else if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      writes.push(body);
      rules.push({ id: 'new-rule', ...body });
      result = { id: 'test-ruleset', rules };
    } else result = { id: 'test-ruleset', rules };
    return Response.json({ success: true, result });
  });
  return { rules, writes };
}

test('Access transport exception is limited to one hostname and SBFM phase', async (t) => {
  const { rules, writes } = fixture(t);
  await ensureEdgeAccess(app);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expression, '(http.host eq "gods.lily.lat")');
  assert.deepEqual(writes[0].action_parameters, {
    phases: ['http_request_sbfm'],
  });
  assert.equal(rules[0].action, 'block');
  assert.equal(rules[0].expression, 'ip.src eq 192.0.2.1');
});

test('Access bypass prevents creation of a bot challenge exception', async (t) => {
  const { writes } = fixture(t, { bypass: true });
  await assert.rejects(ensureEdgeAccess(app));
  assert.equal(writes.length, 0);
});

test('a broader existing exception fails closed without overwriting it', async (t) => {
  const { writes } = fixture(t, { existing: true });
  await assert.rejects(ensureEdgeAccess(app), /Transport rule expression/);
  assert.equal(writes.length, 0);
});
