import { Container, getContainer } from '@cloudflare/containers';
import {
  containerEnvironment,
  probeAuthorized,
  proxyRequest,
} from './policy.js';

const PRIMARY = 'gods-eye-primary';
const DOMAIN = 'gods.lily.lat';
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export class GodsEyeViewContainer extends Container {
  defaultPort = 4173;
  sleepAfter = '30m';
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = containerEnvironment(env);
  }

  async record(event, details = {}) {
    const lifecycle = (await this.ctx.storage.get('gev-lifecycle')) || {
      starts: 0,
      stops: 0,
      errors: 0,
    };
    if (event === 'start') lifecycle.starts++;
    if (event === 'stop') lifecycle.stops++;
    if (event === 'error') lifecycle.errors++;
    lifecycle.lastEvent = { event, at: new Date().toISOString(), ...details };
    await this.ctx.storage.put('gev-lifecycle', lifecycle);
    console.log(
      JSON.stringify({ component: 'container', ...lifecycle.lastEvent }),
    );
  }
  async onStart() {
    await this.record('start');
  }
  async onStop({ exitCode, reason }) {
    await this.record('stop', { exitCode, reason });
  }
  async onError(error) {
    await this.record('error', { name: error?.name || 'Error' });
    throw error;
  }
  async diagnostics() {
    return {
      state: await this.getState(),
      lifecycle: (await this.ctx.storage.get('gev-lifecycle')) || null,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const container = () => getContainer(env.GODS_EYE, PRIMARY);
    if (url.pathname.startsWith('/__ops/')) {
      if (!probeAuthorized(request, env))
        return json({ error: 'not_found' }, 404);
      if (url.pathname === '/__ops/status' && request.method === 'GET')
        return json(await container().diagnostics());
      if (url.pathname === '/__ops/stop' && request.method === 'POST') {
        await container().stop();
        return json({ ok: true });
      }
      if (url.pathname === '/__ops/health' && request.method === 'GET')
        return container().fetch(proxyRequest(request, '/__health'));
      if (url.pathname === '/__ops/ws' && request.method === 'GET')
        return container().fetch(proxyRequest(request, '/__health/ws'));
      return json({ error: 'not_found' }, 404);
    }
    // Hostname-based Access must not have a public workers.dev side entrance.
    if (
      url.hostname !== DOMAIN &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    ) {
      url.hostname = DOMAIN;
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname.startsWith('/__health'))
      return json({ error: 'not_found' }, 404);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        // No blind retries: even a GET can mint a billable Realtime session.
        const response = await container().fetch(proxyRequest(request));
        if (response.status >= 500)
          console.warn(
            JSON.stringify({
              event: 'api_response',
              status: response.status,
              path: url.pathname,
            }),
          );
        return response;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'container_proxy_error',
            name: error?.name || 'Error',
          }),
        );
        return json({ error: 'container_unavailable' }, 503);
      }
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return json({ error: 'method_not_allowed' }, 405);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-GEV-Revision', env.GEV_REVISION || 'local');
    if (headers.get('Content-Type')?.includes('text/html'))
      headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  },
};
