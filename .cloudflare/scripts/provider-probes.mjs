import assert from 'node:assert/strict';
import { evidence } from './cloudflare-api.mjs';

/** Bounded live samples; record external outages separately from runtime faults. */
export async function providerProbes(base, headers, secretNames = []) {
  const samples = [
    {
      provider: 'OpenSky / ADS-B fallback',
      path: '/api/opensky?lamin=30&lamax=31&lomin=-98&lomax=-97',
    },
    { provider: 'ADS-B military', path: '/api/adsblol/mil' },
    { provider: 'CelesTrak satellites', path: '/api/celestrak/stations' },
    { provider: 'CCTV catalog', path: '/api/cctv/sources' },
    { provider: 'Radio catalog', path: '/api/radio/stations' },
    {
      provider: 'Terrain',
      path: '/api/terrain/heights?points=-97.7431,30.2672',
    },
    { provider: 'Launch Library', path: '/api/launches' },
    {
      provider: 'Overpass',
      path: '/api/overpass',
      method: 'POST',
      body: '[out:json][timeout:8];node(30.267,-97.744,30.268,-97.743)[amenity];out 3;',
    },
  ];
  if (!secretNames.includes('OPENAI_API_KEY'))
    samples.push({
      provider: 'OpenAI keyless',
      path: '/api/realtime/token',
      expected: 503,
    });
  if (!secretNames.includes('AISSTREAM_API_KEY'))
    samples.push({
      provider: 'AIS keyless',
      path: '/api/ais-live',
      expected: 503,
    });
  if (
    !secretNames.some((name) =>
      ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_SERVER_API_KEY'].includes(name),
    )
  )
    samples.push({
      provider: 'Google Places keyless',
      path: '/api/google/nearby-places',
      expected: 200,
    });
  const results = [];
  // Four at a time is enough to exercise concurrency without flooding providers.
  for (let start = 0; start < samples.length; start += 4) {
    const batch = await Promise.all(
      samples.slice(start, start + 4).map(async (sample) => {
        const began = Date.now();
        try {
          const response = await fetch(new URL(sample.path, base), {
            method: sample.method || 'GET',
            headers: { ...headers, Origin: new URL(base).origin },
            body: sample.body,
            redirect: 'manual',
            signal: AbortSignal.timeout(45000),
          });
          const text = await response.text();
          const runtimeFault =
            text.includes('Container suddenly disconnected') ||
            text.includes('container_unavailable') ||
            text.includes('Error proxying request to container');
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            /* TLE providers return text. */
          }
          const data =
            payload?.states ||
            payload?.ac ||
            payload?.sources ||
            payload?.stations ||
            payload?.results ||
            payload?.elements ||
            payload?.rows;
          return {
            provider: sample.provider,
            status: response.status,
            expectedKeylessStatus: sample.expected,
            ms: Date.now() - began,
            bytes: Buffer.byteLength(text),
            ...(Array.isArray(data) ? { rows: data.length } : {}),
            ...(typeof payload?.configured === 'boolean'
              ? { configured: payload.configured }
              : {}),
            ...(typeof payload?.stale === 'boolean'
              ? { stale: payload.stale }
              : {}),
            runtimeFault,
          };
        } catch (error) {
          return {
            provider: sample.provider,
            ms: Date.now() - began,
            error: error.name,
            runtimeFault: true,
          };
        }
      }),
    );
    results.push(...batch);
  }
  await evidence('provider-probes', results);
  for (const result of results) console.log(JSON.stringify(result));
  assert.ok(
    results.every((result) => !result.runtimeFault),
    'Provider probes must not encounter runtime disconnects/timeouts',
  );
  for (const result of results)
    if (result.expectedKeylessStatus)
      assert.equal(
        result.status,
        result.expectedKeylessStatus,
        result.provider,
      );
  assert.ok(
    results.filter((r) => r.status === 200 && !r.expectedKeylessStatus)
      .length >= 2,
    'At least two external providers must return live data successfully',
  );
  return results;
}
