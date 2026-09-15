import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { api, list, domain, evidence } from './cloudflare-api.mjs';

// Read from the production zone during migration: this presentation rule
// replaces genuine API 401/405/406/etc. responses with one HTML 403 page.
const RULE_ID = '4ded32ebdd7a4c99bf8b579c60ca5ab3';
const ORIGINAL =
  '(http.response.code in {403 401 405 406 409 410 413 414 415 429})';
const DESIRED = `${ORIGINAL} and (http.host ne "${domain}")`;

function definition({ id, version, last_updated, ...value }) {
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function digest(rules) {
  // Compare complete definitions and order without exposing error-page bodies
  // or asset configuration in an assertion failure or artifact.
  const content = rules.map((rule) => ({ id: rule.id, ...definition(rule) }));
  return createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex');
}

export async function ensureErrorResponses() {
  const zones = await list('/zones?name=lily.lat');
  const zone = zones.find(
    (value) =>
      value.name === 'lily.lat' &&
      value.account.id === process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  assert.ok(zone, 'Expected production zone');
  const base = `/zones/${zone.id}/rulesets`;
  let current;
  try {
    current = await api(`${base}/phases/http_custom_errors/entrypoint`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await evidence('edge-error-responses', {
      hostname: domain,
      rulePresent: false,
    });
    return;
  }
  assert.equal(current.phase, 'http_custom_errors');
  const rule = current.rules?.find((value) => value.id === RULE_ID);
  if (!rule || rule.enabled === false) {
    await evidence('edge-error-responses', {
      hostname: domain,
      rulePresent: Boolean(rule),
      enabled: false,
    });
    return;
  }
  assert.equal(rule.action, 'serve_error');
  assert.equal(rule.action_parameters?.status_code, 403);
  assert.ok(
    [ORIGINAL, DESIRED].includes(rule.expression),
    'The observed custom error rule changed; review its new scope before editing',
  );
  const expected = current.rules.map((value) =>
    value.id === RULE_ID ? { ...value, expression: DESIRED } : value,
  );
  const changed = rule.expression !== DESIRED;
  if (changed) {
    // The rule PATCH endpoint replaces its definition: preserve every existing
    // writable field and change only this exact hostname exclusion.
    await api(`${base}/${current.id}/rules/${RULE_ID}`, {
      method: 'PATCH',
      body: { ...definition(rule), expression: DESIRED },
    });
  }
  const after = await api(`${base}/${current.id}`);
  assert.equal(
    digest(after.rules),
    digest(expected),
    'Custom error readback must preserve all other definitions and rule order',
  );
  await evidence('edge-error-responses', {
    hostname: domain,
    rulesetId: current.id,
    ruleId: RULE_ID,
    changed,
    expression: DESIRED,
    unrelatedRulesPreserved: true,
    otherHostnamesPreserved: true,
    accessAndWafEnforcementUnchanged: true,
    snippetsUnchanged: true,
  });
}
