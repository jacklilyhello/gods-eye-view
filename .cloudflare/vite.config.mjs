import { createBrowserViteConfig } from '../build/vite.js';

// Do not load .env files or install server plugins during the browser build.
// Upstream's two client-exposed credentials deliberately stay keyless here.
export default {
  ...createBrowserViteConfig(),
  envDir: false,
  envPrefix: '__GEV_NO_PUBLIC_ENV__',
};
