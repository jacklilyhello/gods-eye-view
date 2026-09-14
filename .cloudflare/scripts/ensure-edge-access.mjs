import assert from 'node:assert/strict';
import { api, list, accountPath, domain, evidence } from './cloudflare-api.mjs';

// SBFM runs before Access, so its interactive challenges prevent service-token
// and WebSocket clients from ever reaching authentication. Scope the exception
// to this private hostname and this phase; WAF rules and Access still execute.
export async function ensureEdgeAccess(app) {
  assert.equal(app.domain, domain);
  assert.equal(app.type, 'self_hosted');
  const policies = await list(`${accountPath}/access/apps/${app.id}/policies`);
  assert.ok(policies.some((policy) => policy.decision === 'allow'));
  assert.ok(!policies.some((policy) => policy.decision === 'bypass'));
  const zones = await list('/zones?name=lily.lat');
  const zone = zones.find(
    (value) => value.account.id === process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  assert.ok(zone, 'Expected production zone');
  const base = `/zones/${zone.id}/rulesets`;
  const current = await api(
    `${base}/phases/http_request_firewall_custom/entrypoint`,
  );
  const desired = {
    ref: 'gods_eye_access_transport',
    description:
      'Gods Eye View: Access authenticates browser and service transport',
    expression: `(http.host eq "${domain}")`,
    action: 'skip',
    action_parameters: { phases: ['http_request_sbfm'] },
    logging: { enabled: true },
    enabled: true,
  };
  const existing =
    current.rules?.filter((rule) => rule.ref === desired.ref) || [];
  assert.ok(existing.length <= 1, 'Duplicate transport rule');
  if (!existing.length)
    await api(`${base}/${current.id}/rules`, { method: 'POST', body: desired });
  const after = await api(`${base}/${current.id}`);
  const actual = after.rules?.find((rule) => rule.ref === desired.ref);
  assert.ok(actual, 'Transport rule must exist after write');
  for (const key of [
    'expression',
    'action',
    'action_parameters',
    'enabled',
    'logging',
  ])
    assert.deepEqual(actual[key], desired[key], `Transport rule ${key}`);
  const unrelated = (rules) =>
    rules
      .filter((rule) => rule.ref !== desired.ref)
      .map(({ id, expression, action, action_parameters, enabled }) => ({
        id,
        expression,
        action,
        action_parameters,
        enabled,
      }));
  assert.deepEqual(
    unrelated(after.rules),
    unrelated(current.rules),
    'Existing zone rules must remain unchanged',
  );
  await evidence('edge-access-transport', {
    ruleId: actual.id,
    hostname: domain,
    skippedPhases: desired.action_parameters.phases,
    accessApplication: app.id,
    existingCustomRulesPreserved: true,
    managedWafAndRateLimitsPreserved: true,
  });
}
