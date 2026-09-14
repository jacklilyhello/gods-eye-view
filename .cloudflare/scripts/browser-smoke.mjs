import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { evidence, evidenceDir } from './cloudflare-api.mjs';

export async function browserSmoke(base, headers = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    const errors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 240)));
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      failedRequests.push({
        host: url.hostname,
        path: url.pathname,
        error: request.failure()?.errorText,
      });
    });
    // Access service credentials only go to our exact origin, never to maps,
    // radio, analytics, redirects or any third-party data provider.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const own = new URL(request.url()).origin === new URL(base).origin;
      // Strip any inherited credential headers, including redirected requests,
      // before adding them back only for this application's exact origin.
      const cleanHeaders = Object.fromEntries(
        Object.entries(request.headers()).filter(
          ([name]) => !/^cf-access-client-(id|secret)$/i.test(name),
        ),
      );
      void request.continue({
        headers: own ? { ...cleanHeaders, ...headers } : cleanHeaders,
      });
    });
    const response = await page.goto(base, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    assert.equal(response.status(), 200);
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('.cesium-widget canvas');
        const loader = document.querySelector('#loading-screen');
        return (
          canvas?.width > 0 &&
          canvas?.height > 0 &&
          (!loader ||
            getComputedStyle(loader).display === 'none' ||
            getComputedStyle(loader).visibility === 'hidden' ||
            Number(getComputedStyle(loader).opacity) === 0)
        );
      },
      { timeout: 90000 },
    );
    const state = await page.evaluate(() => ({
      title: document.title,
      canvasCount: document.querySelectorAll('canvas').length,
      text: document.body.innerText.slice(0, 1000),
    }));
    const websocket = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const url = new URL('/__transport/ws', location.href);
          url.protocol = 'wss:';
          const ws = new WebSocket(url);
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('Browser WebSocket timeout'));
          }, 20000);
          ws.onopen = () => ws.send('browser-transport-probe');
          ws.onmessage = (event) => {
            clearTimeout(timer);
            ws.close(1000);
            event.data === 'browser-transport-probe'
              ? resolve('cookie-authenticated echo passed')
              : reject(new Error('Browser WebSocket echo mismatch'));
          };
          ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Browser WebSocket failed'));
          };
        }),
    );
    await page.keyboard.press('Escape');
    await evidence('browser', {
      ...state,
      websocket,
      pageErrors: errors,
      failedRequests,
    });
    await page.screenshot({
      path: `${evidenceDir}/production-desktop.png`,
      fullPage: false,
    });
    assert.deepEqual(
      errors,
      [],
      'Browser must initialize without uncaught errors',
    );
    return {
      ...state,
      websocket,
      pageErrors: errors.length,
      failedRequests: failedRequests.length,
    };
  } finally {
    await browser.close();
  }
}
