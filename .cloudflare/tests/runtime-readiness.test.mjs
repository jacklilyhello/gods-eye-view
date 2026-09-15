import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForRuntime } from '../scripts/wait-for-runtime.mjs';

const revision = 'a'.repeat(40);
const healthy = {
  ok: true,
  server: 'node-production',
  revision,
  imageRevision: revision,
  bootId: 'new-image-process',
};

test('a new Worker cannot make an old image pass readiness', async () => {
  const responses = [
    { ...healthy, imageRevision: undefined, bootId: 'legacy-process' },
    { ...healthy, imageRevision: 'b'.repeat(40), bootId: 'old-image-process' },
    healthy,
  ];
  const samples = [];
  let waits = 0;
  const result = await waitForRuntime({
    revision,
    readHealth: async () => responses.shift(),
    sleep: async () => waits++,
    onSample: (sample) => samples.push(sample),
  });
  assert.equal(result.bootId, 'new-image-process');
  assert.deepEqual(
    samples.map((sample) => sample.ready),
    [false, false, true],
  );
  assert.equal(waits, 2);
});

test('readiness tolerates startup failure but still checks both revisions', async () => {
  let attempts = 0;
  const samples = [];
  await waitForRuntime({
    revision,
    readHealth: async () => {
      if (++attempts === 1) throw new Error('private startup request details');
      if (attempts === 2) return { ...healthy, revision: 'b'.repeat(40) };
      return healthy;
    },
    sleep: async () => {},
    onSample: (sample) => samples.push(sample),
  });
  assert.equal(attempts, 3);
  assert.ok(!JSON.stringify(samples).includes('private'));
});

test('readiness fails within its bound when the image never catches up', async () => {
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    waitForRuntime({
      revision,
      attempts: 3,
      readHealth: async () => {
        attempts++;
        return { ...healthy, imageRevision: 'b'.repeat(40) };
      },
      sleep: async () => waits++,
    }),
    /Worker and Container image did not become ready/,
  );
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});
