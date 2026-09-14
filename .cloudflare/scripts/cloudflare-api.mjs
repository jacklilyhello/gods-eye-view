import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

export const accountPath = `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}`;
export const domain = 'gods.lily.lat';
export const worker = 'gods-eye-view';
export const evidenceDir = process.env.GEV_EVIDENCE_DIR || 'output/cloudflare';

function safeMessage(message) {
  let value = String(message || '');
  for (const [name, secret] of Object.entries(process.env))
    if (/TOKEN|SECRET|PASSWORD|EMAIL|ACCOUNT_ID|API_KEY/.test(name) && secret)
      value = value.replaceAll(secret, '[redacted]');
  return value.replace(/[A-Za-z0-9_-]{60,}/g, '[redacted]').slice(0, 500);
}

export async function evidence(name, data) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/${name}.json`, JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ evidence: name, saved: true }));
}

export async function api(path, { method = 'GET', body } = {}) {
  assert.ok(
    process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID,
    'Cloudflare credentials required',
  );
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) {
    const error = new Error(
      `Cloudflare ${method} ${path.replace(accountPath, '/accounts/ACCOUNT')} HTTP ${response.status}; ${(result.errors || []).map((e) => `${e.code}: ${safeMessage(e.message)}`).join('; ')}`,
    );
    error.status = response.status;
    throw error;
  }
  return result.result ?? result;
}

export async function list(path) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(result), 'Expected paginated array');
    rows.push(...result);
    if (result.length < 100) return rows;
  }
  throw new Error('Cloudflare pagination exceeded bounded read limit');
}

async function containerMetrics(applicationId, label) {
  try {
    const result = await api('/graphql', {
      method: 'POST',
      body: {
        query: `query Metrics($account: String, $start: Time, $end: Time, $application: String) {
        viewer { accounts(filter: {accountTag: $account}) {
          containersMetricsAdaptiveGroups(limit: 300, filter: {datetime_geq: $start, datetime_leq: $end, applicationId: $application}, orderBy: [datetimeFiveMinutes_ASC]) {
            count dimensions {datetimeFiveMinutes instanceId placementId location}
            max {memory cpuUtilization containerUptime} avg {memory cpuUtilization}
          }
        }}
      }`,
        variables: {
          account: process.env.CLOUDFLARE_ACCOUNT_ID,
          start: new Date(Date.now() - 4 * 3600000).toISOString(),
          end: new Date().toISOString(),
          application: applicationId,
        },
      },
    });
    if (result.errors?.length) {
      await evidence(`${label}-metrics`, {
        available: false,
        errors: result.errors.map((error) => ({
          message: safeMessage(error.message),
        })),
      });
      return;
    }
    const rows =
      result.data?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups;
    await evidence(`${label}-metrics`, {
      available: Array.isArray(rows),
      rows,
      note: 'Cloudflare sampled workload metrics; availability and reporting lag are separate from Node health.',
    });
  } catch (error) {
    await evidence(`${label}-metrics`, {
      available: false,
      reason: error.message,
    });
  }
}

async function edgeDiagnostics(zoneId, label) {
  const report = {};
  try {
    report.workerRoutes = (await list(`/zones/${zoneId}/workers/routes`))
      .filter((route) => {
        const hostname = route.pattern
          .replace(/^https?:\/\//, '')
          .split('/')[0]
          .toLowerCase();
        return hostname.startsWith('*.')
          ? domain.endsWith(`.${hostname.slice(2)}`)
          : hostname.startsWith('*')
            ? domain.endsWith(hostname.slice(1))
            : hostname === domain;
      })
      .map(({ id, pattern, script }) => ({
        id,
        pattern,
        script: script || null,
      }));
  } catch (error) {
    report.workerRoutesError = safeMessage(error.message);
  }
  for (const [scope, prefix] of [
    ['zone', `/zones/${zoneId}`],
    ['account', accountPath],
  ]) {
    try {
      const value = await api(
        `${prefix}/rulesets/phases/http_custom_errors/entrypoint`,
      );
      report[`${scope}ErrorRules`] = {
        id: value.id,
        rules: value.rules?.map((rule) => ({
          id: rule.id,
          action: rule.action,
          enabled: rule.enabled,
          description: rule.description,
          // Custom error expressions use response metadata. Redact credentials
          // and never include the response body or custom asset URL.
          expression: safeMessage(
            rule.expression?.replace(/"(?:[^"\\]|\\.)*"/g, '"[redacted]"'),
          ),
          statusCode: rule.action_parameters?.status_code,
          contentType: rule.action_parameters?.content_type,
          usesAsset: Boolean(rule.action_parameters?.asset_name),
        })),
      };
    } catch (error) {
      report[`${scope}ErrorRules`] = {
        status: error.status,
        reason: safeMessage(error.message),
      };
    }
  }
  for (const [name, path] of Object.entries({
    botManagement: `/zones/${zoneId}/bot_management`,
    securityLevel: `/zones/${zoneId}/settings/security_level`,
    websockets: `/zones/${zoneId}/settings/websockets`,
    customRules: `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
  })) {
    try {
      const value = await api(path);
      report[name] =
        name === 'customRules'
          ? {
              id: value.id,
              rules: value.rules?.map((rule) => ({
                id: rule.id,
                action: rule.action,
                enabled: rule.enabled,
                description: rule.description,
                mentionsHostname: rule.expression?.includes(domain),
                mentionsAccess: /access/i.test(rule.expression || ''),
              })),
            }
          : ['securityLevel', 'websockets'].includes(name)
            ? { value: value.value }
            : {
                fightMode: value.fight_mode,
                enableJs: value.enable_js,
                sbfmDefinitelyAutomated: value.sbfm_definitely_automated,
                sbfmLikelyAutomated: value.sbfm_likely_automated,
              };
    } catch (error) {
      report[name] = {
        available: false,
        status: error.status,
        reason: safeMessage(error.message),
      };
    }
  }
  try {
    const result = await api('/graphql', {
      method: 'POST',
      body: {
        query: `query EdgeEvents($zone: string, $filter: FirewallEventsAdaptiveFilter_InputObject) {
        viewer { zones(filter: {zoneTag: $zone}) {
          firewallEventsAdaptive(limit: 30, filter: $filter, orderBy: [datetime_DESC]) {
            datetime action source ruleId clientRequestHTTPHost clientRequestPath clientRequestHTTPMethodName
          }
        }}
      }`,
        variables: {
          zone: zoneId,
          filter: {
            datetime_geq: new Date(Date.now() - 3600000).toISOString(),
            datetime_leq: new Date().toISOString(),
            clientRequestHTTPHost: domain,
            action_in: [
              'block',
              'managed_challenge',
              'challenge',
              'js_challenge',
            ],
          },
        },
      },
    });
    report.events = result.data?.viewer?.zones?.[0]?.firewallEventsAdaptive;
    report.eventsAvailable = Array.isArray(report.events);
    if (result.errors?.length)
      report.eventsErrors = result.errors.map((error) =>
        safeMessage(error.message),
      );
  } catch (error) {
    report.eventsAvailable = false;
    report.eventsStatus = error.status;
  }
  // Resolve only rule IDs observed for our hostname. Do not publish rule
  // expressions or inspect unrelated request payloads from the shared zone.
  try {
    const observed = new Set(report.events?.map((event) => event.ruleId));
    report.managedRules = [];
    for (const phase of [
      'http_request_firewall_managed',
      'http_request_sbfm',
    ]) {
      const entrypoint = await api(
        `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
      );
      for (const execute of (entrypoint.rules || []).filter(
        (rule) => rule.action === 'execute' && rule.enabled !== false,
      )) {
        const ruleset = await api(
          `/zones/${zoneId}/rulesets/${execute.action_parameters.id}`,
        );
        report.managedRules.push({
          rulesetId: ruleset.id,
          name: ruleset.name,
          phase,
          matchingRules: (ruleset.rules || [])
            .filter((rule) => observed.has(rule.id))
            .map((rule) => ({
              id: rule.id,
              description: rule.description,
              action: rule.action,
              enabled: rule.enabled,
            })),
        });
      }
    }
  } catch (error) {
    report.managedRulesError = safeMessage(error.message);
  }
  await evidence(`${label}-edge`, report);
}

export async function inspect(label) {
  const settings = await api(
    `${accountPath}/workers/scripts/${worker}/settings`,
  );
  const zones = await list('/zones?name=lily.lat');
  const zone = zones.find(
    (z) =>
      z.name === 'lily.lat' &&
      z.account.id === process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  assert.ok(zone, 'lily.lat must belong to deployment account');
  const domains = (await list(`${accountPath}/workers/domains`)).filter(
    (d) => d.hostname === domain || d.service === worker,
  );
  assert.ok(
    domains.every((d) => d.hostname !== domain || d.service === worker),
    'Custom domain already belongs to another Worker',
  );
  const dns = await list(`/zones/${zone.id}/dns_records?name=${domain}`);
  const applications = await api(`${accountPath}/containers/applications`);
  const application = applications.find(
    (app) => app.name === 'gods-eye-view-godseyeviewcontainer',
  );
  assert.ok(application, 'Expected existing Container application');
  await containerMetrics(application.id, label);
  await edgeDiagnostics(zone.id, label);
  // Explicit allowlists: no provider values, account tokens or environment maps.
  const report = {
    observedAt: new Date().toISOString(),
    worker,
    zoneStatus: zone.status,
    compatibilityDate: settings.compatibility_date,
    bindings: settings.bindings?.map((b) => ({
      name: b.name,
      type: b.type,
      className: b.class_name,
    })),
    observability: settings.observability,
    domains: domains.map((d) => ({ hostname: d.hostname, service: d.service })),
    dns: dns.map((d) => ({ type: d.type, name: d.name, proxied: d.proxied })),
    container: {
      id: application.id,
      name: application.name,
      maxInstances: application.max_instances,
      instanceType: application.configuration?.instance_type,
      resources: {
        vcpu: application.configuration?.vcpu,
        memoryMiB: application.configuration?.memory_mib,
        diskMB: application.configuration?.disk?.size_mb,
      },
      image: application.configuration?.image?.replace(
        process.env.CLOUDFLARE_ACCOUNT_ID,
        'ACCOUNT',
      ),
      observability: application.configuration?.observability,
    },
    placementHistory: {
      available: false,
      reason:
        'The application deployments endpoint is not exposed by the Containers API (HTTP 404). Runtime lifecycle is verified through Durable Object and Node health probes.',
    },
  };
  await evidence(label, report);
  console.log(JSON.stringify(report));
  return { report, application, settings };
}
