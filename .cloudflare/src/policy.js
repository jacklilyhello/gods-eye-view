export const CONTAINER_ENV_KEYS = [
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENAI_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'OPENSKY_USERNAME',
  'OPENSKY_PASSWORD',
  'OPENSKY_AUTH_MODE',
  'AISSTREAM_API_KEY',
  'AISSTREAM_BOUNDING_BOXES',
  'AISSTREAM_MESSAGE_TYPES',
  'AISSTREAM_SILENCE_TIMEOUT_MS',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'TOMTOM_DAILY_TILE_BUDGET',
  'LL2_API_TOKEN',
  'TFL_APP_KEY',
  'OPENAI_REALTIME_MODEL',
  'OPENAI_REALTIME_MODEL_MINI',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_REALTIME_REASONING_EFFORT',
  'OPENAI_REALTIME_CONTEXT_TOKENS',
  'OPENAI_REALTIME_CONTEXT_RETENTION',
  'OPENAI_HUD_SUMMARY_MODEL',
  'GEV_RATELIMIT_OPENAI_PER_MIN',
  'GEV_RATELIMIT_GOOGLE_PER_MIN',
  'CCTV_SOURCES_JSON',
  'CCTV_TFL_ENABLED',
  'CCTV_CALTRANS_DISTRICTS',
  'CCTV_MAX_SOURCES',
  'CCTV_AUSTIN_MAX_SOURCES',
  'CCTV_CALTRANS_MAX_SOURCES',
  'CCTV_TFL_MAX_SOURCES',
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
];

export function containerEnvironment(env) {
  const values = {
    HOST: '0.0.0.0',
    PORT: '4173',
    NODE_ENV: 'production',
    GEV_REVISION: env.GEV_REVISION || 'local',
    OPENSKY_AUTH_MODE:
      env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET ? 'oauth' : 'anon',
    GEV_RATELIMIT_OPENAI_PER_MIN: '20',
    GEV_RATELIMIT_GOOGLE_PER_MIN: '60',
  };
  for (const key of CONTAINER_ENV_KEYS)
    if (typeof env[key] === 'string') values[key] = env[key];
  return values;
}

export function probeAuthorized(request, env) {
  const expected = env.GEV_DEPLOY_PROBE_TOKEN;
  const actual = request.headers.get('x-gev-probe-token') || '';
  if (!expected || expected.length < 32 || actual.length !== expected.length)
    return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++)
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export function proxyRequest(request, pathname) {
  const url = new URL(request.url);
  if (pathname) url.pathname = pathname;
  const headers = new Headers(request.headers);
  for (const key of [
    'x-gev-probe-token',
    'cf-access-client-id',
    'cf-access-client-secret',
    'cf-access-jwt-assertion',
    'authorization',
    'cookie',
    'cf-container-target-port',
  ])
    headers.delete(key);
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    duplex: 'half',
  });
}
