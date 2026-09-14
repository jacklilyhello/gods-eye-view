import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

export const accountPath = `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}`;
export const domain = 'gods.lily.lat';
export const worker = 'gods-eye-view';
export const evidenceDir = process.env.GEV_EVIDENCE_DIR || 'output/cloudflare';

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
      `Cloudflare ${method} ${path.replace(accountPath, '/accounts/ACCOUNT')} HTTP ${response.status}; codes ${(result.errors || []).map((e) => e.code).join(',')}`,
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
  const deployments = await api(
    `${accountPath}/containers/applications/${application.id}/deployments`,
  );
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
      image: application.configuration?.image?.replace(
        process.env.CLOUDFLARE_ACCOUNT_ID,
        'ACCOUNT',
      ),
      observability: application.configuration?.observability,
    },
    deployments: deployments.map((d) => ({
      id: d.id,
      createdAt: d.created_at,
      status: d.status,
      placements: d.placements?.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.created_at,
        terminatedAt: p.terminated_at,
        events: p.events?.map((e) => ({
          type: e.type,
          name: e.name,
          timestamp: e.timestamp,
          exitCode: e.exit_code,
        })),
      })),
    })),
  };
  await evidence(label, report);
  console.log(JSON.stringify(report));
  return { report, application, settings };
}
