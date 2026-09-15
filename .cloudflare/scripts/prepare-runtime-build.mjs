import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// This file is copied into the image, not supplied by the newer Worker at
// startup. Worker deployment and Container image rollout are asynchronous.
const revision = process.env.GITHUB_SHA || 'local';
assert.ok(
  /^[a-f0-9]{40}$/.test(revision) ||
    (revision === 'local' && process.env.GITHUB_ACTIONS !== 'true'),
  'A production image requires the checked-out GitHub SHA',
);
await writeFile(
  new URL('../runtime/build-info.json', import.meta.url),
  JSON.stringify({ revision }) + '\n',
);
console.log(JSON.stringify({ imageRevision: revision }));
