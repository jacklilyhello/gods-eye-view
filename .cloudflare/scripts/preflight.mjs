import { randomBytes } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { inspect } from './cloudflare-api.mjs';

await inspect('infrastructure-before');
const token = randomBytes(32).toString('hex');
console.log(`::add-mask::${token}`);
await writeFile(
  `${process.env.RUNNER_TEMP}/gods-probe.json`,
  JSON.stringify({ GEV_DEPLOY_PROBE_TOKEN: token }),
  { mode: 0o600 },
);
await appendFile(process.env.GITHUB_ENV, `GEV_DEPLOY_PROBE_TOKEN=${token}\n`);
