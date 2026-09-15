import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'gev-errors-test-'));
process.env.GEV_EVIDENCE_DIR = temporary;
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-only-token';
const { ensureErrorResponses } =
  await import('../scripts/ensure-error-responses.mjs');
after(() => rm(temporary, { recursive: true }));

function fixture(t, { changedScope = false, readbackDrift = false } = {}) {
  const rules = [
    {
      id: 'other-rule',
      action: 'serve_error',
      expression: 'http.host eq "other.example"',
      action_parameters: { status_code: 404, asset_name: 'private-asset-name' },
      enabled: true,
    },
    {
      id: '4ded32ebdd7a4c99bf8b579c60ca5ab3',
      action: 'serve_error',
      expression: changedScope
        ? 'true'
        : '(http.response.code in {403 401 405 406 409 410 413 414 415 429})',
      action_parameters: {
        status_code: 403,
        content_type: 'text/html',
        asset_name: 'original-page',
      },
      description: 'Existing error page',
      enabled: true,
      ref: 'original-ref',
      version: '5',
      last_updated: 'before',
    },
  ];
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    let result;
    if (pathname.endsWith('/zones'))
      result = [
        { id: 'test-zone', name: 'lily.lat', account: { id: 'test-account' } },
      ];
    else {
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        writes.push({ pathname, body });
        rules[1] = {
          id: rules[1].id,
          ...body,
          version: '6',
          last_updated: 'after',
        };
        if (readbackDrift) rules[0].expression = 'false';
      }
      result = { id: 'test-ruleset', phase: 'http_custom_errors', rules };
    }
    return Response.json({ success: true, result });
  });
  return { rules, writes };
}

test('error-page repair changes only the production hostname scope and is idempotent', async (t) => {
  const { rules, writes } = fixture(t);
  const otherBefore = structuredClone(rules[0]);
  await ensureErrorResponses();
  await ensureErrorResponses();
  assert.equal(writes.length, 1);
  assert.match(
    writes[0].pathname,
    /\/rulesets\/test-ruleset\/rules\/4ded32ebdd7a4c99bf8b579c60ca5ab3$/,
  );
  assert.equal(
    writes[0].body.expression,
    '(http.response.code in {403 401 405 406 409 410 413 414 415 429}) and (http.host ne "gods.lily.lat")',
  );
  assert.deepEqual(writes[0].body.action_parameters, {
    status_code: 403,
    content_type: 'text/html',
    asset_name: 'original-page',
  });
  assert.equal(writes[0].body.enabled, true);
  assert.equal(writes[0].body.ref, 'original-ref');
  assert.equal(writes[0].body.description, 'Existing error page');
  assert.equal(writes[0].body.version, undefined);
  assert.deepEqual(rules[0], otherBefore);
});

test('a changed rule scope is not overwritten by the migration', async (t) => {
  const { writes } = fixture(t, { changedScope: true });
  await assert.rejects(ensureErrorResponses(), /review its new scope/);
  assert.equal(writes.length, 0);
});

test('readback detects unrelated drift without exposing private error-page configuration', async (t) => {
  fixture(t, { readbackDrift: true });
  await assert.rejects(ensureErrorResponses(), (error) => {
    assert.match(
      error.message,
      /preserve all other definitions and rule order/,
    );
    assert.ok(!error.message.includes('private-asset-name'));
    return true;
  });
});
