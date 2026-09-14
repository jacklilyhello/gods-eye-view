import { Container, getContainer } from '@cloudflare/containers';

const CONTAINER_ENV_KEYS = [
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENAI_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'OPENSKY_AUTH_MODE',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'GEV_RATELIMIT_OPENAI_PER_MIN',
  'GEV_RATELIMIT_GOOGLE_PER_MIN',
];

export class GodsEyeViewContainer extends Container {
  defaultPort = 4173;
  sleepAfter = '30m';

  onStart() {
    console.log('[container] started');
  }

  onStop({ exitCode, reason }) {
    console.log('[container] stopped', { exitCode, reason });
  }

  onError(error) {
    console.error('[container] error', error);
    // Preserve the SDK's default error propagation.
    throw error;
  }

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { HOST: '0.0.0.0', PORT: '4173' };

    // Provider credentials come from Worker secrets at runtime, never the image.
    for (const key of CONTAINER_ENV_KEYS) {
      if (typeof env[key] === 'string') {
        this.envVars[key] = env[key];
      }
    }
  }
}

export default {
  fetch(request, env) {
    return getContainer(env.GODS_EYE, 'gods-eye-primary').fetch(request);
  },
};
