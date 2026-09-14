import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import connect from 'connect';
import { WebSocketServer } from 'ws';
import { localProviderPlugins } from '../../server/providers/local.js';

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

/** Host upstream Connect provider hooks without starting Vite, HMR or a watcher. */
export async function createProductionServer({
  plugins = localProviderPlugins(),
} = {}) {
  const app = connect();
  const server = http.createServer(app);
  const bootId = randomUUID();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let closing = false;
  let requests = 0;
  let active = 0;
  const responseStatuses = {};
  const installed = [];
  // Connect preserves prefix stripping, originalUrl and next() semantics. Wrap
  // promises because Connect itself only catches synchronous handler errors.
  const middlewares = {
    use(route, handler) {
      if (typeof route === 'function') [route, handler] = ['/', route];
      app.use(route, (req, res, next) => {
        try {
          Promise.resolve(handler(req, res, next)).catch(next);
        } catch (error) {
          next(error);
        }
      });
    },
  };
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-GEV-Server', 'node-production');
    res.setHeader('X-GEV-Revision', process.env.GEV_REVISION || 'local');
    if (closing) return json(res, 503, { error: 'server_draining' });
    requests++;
    active++;
    res.once('close', () => {
      active--;
    });
    res.once('finish', () => {
      responseStatuses[res.statusCode] =
        (responseStatuses[res.statusCode] || 0) + 1;
    });
    if (active > 64) return json(res, 503, { error: 'server_busy' });
    next();
  });
  middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/__health') return next();
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    let memoryEvents = null;
    try {
      memoryEvents = await readFile('/sys/fs/cgroup/memory.events', 'utf8');
    } catch {
      /* Non-Linux development. */
    }
    json(res, 200, {
      ok: true,
      server: 'node-production',
      revision: process.env.GEV_REVISION || 'local',
      bootId,
      uptimeSeconds: Math.floor(process.uptime()),
      requests,
      active,
      responseStatuses,
      memory: process.memoryUsage(),
      memoryEvents,
      eventLoopDelayP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
      providers: installed,
    });
  });
  // Upstream key setup writes .env and restarts Vite; production credentials
  // belong in Worker Secrets. No writable browser key endpoint is installed.
  const postHooks = [];
  for (const plugin of plugins.flat(Infinity)) {
    if (!plugin || plugin.name === 'gev-key-setup') continue;
    if (typeof plugin.configurePreviewServer !== 'function') {
      throw new Error(`Provider ${plugin.name} needs a production hook`);
    }
    const postHook = await plugin.configurePreviewServer({
      middlewares,
      httpServer: server,
    });
    if (typeof postHook === 'function') postHooks.push(postHook);
    installed.push(plugin.name);
  }
  for (const postHook of postHooks) await postHook();
  app.use((_req, res) => json(res, 404, { error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    console.error(
      JSON.stringify({
        event: 'provider_handler_error',
        name: error?.name || 'Error',
      }),
    );
    if (res.headersSent) return res.destroy();
    json(res, 500, { error: 'provider_handler_error' });
  });

  // Bounded synthetic probe, distinct from AIS and OpenAI. The Worker only
  // exposes this through the authenticated deployment probe route.
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (closing || req.url !== '/__health/ws' || sockets.clients.size >= 8) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const deadline = setTimeout(
        () => ws.close(1000, 'probe complete'),
        15000,
      );
      ws.on('error', () => {});
      ws.on('message', (data) => ws.send(data.toString()));
      ws.on('close', () => clearTimeout(deadline));
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    delay.disable();
    for (const ws of sockets.clients) ws.close(1001, 'server shutdown');
    const deadline = setTimeout(() => {
      for (const ws of sockets.clients) ws.terminate();
      server.closeAllConnections();
    }, 5000).unref();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(deadline);
    for (const plugin of plugins) await plugin.closeBundle?.();
    console.log(JSON.stringify({ event: 'server_stopped', bootId, requests }));
  };
  return { server, close, installed, bootId };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { server, close, installed, bootId } = await createProductionServer();
  server.listen(
    Number(process.env.PORT || 4173),
    process.env.HOST || '0.0.0.0',
    () => {
      console.log(
        JSON.stringify({
          event: 'server_started',
          bootId,
          revision: process.env.GEV_REVISION || 'local',
          providers: installed.length,
          rssBytes: process.memoryUsage().rss,
        }),
      );
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  process.on('uncaughtExceptionMonitor', (error) => {
    console.error(JSON.stringify({ event: 'process_fatal', name: error.name }));
  });
}
