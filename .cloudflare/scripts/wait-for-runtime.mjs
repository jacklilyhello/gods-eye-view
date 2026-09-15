import { setTimeout as delay } from 'node:timers/promises';

export async function waitForRuntime({
  readHealth,
  revision,
  attempts = 60,
  intervalMs = 5000,
  sleep = delay,
  onSample = () => {},
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let health;
    try {
      health = await readHealth();
    } catch (error) {
      // Error messages can contain request credentials; keep only the type.
      onSample({ attempt, ready: false, error: error.name });
    }
    if (health) {
      const ready =
        health.ok === true &&
        health.server === 'node-production' &&
        health.revision === revision &&
        health.imageRevision === revision;
      onSample({
        attempt,
        ready,
        workerRevision: health.revision,
        imageRevision: health.imageRevision || null,
        bootId: health.bootId,
      });
      if (ready) return health;
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(
    'New production Worker and Container image did not become ready',
  );
}
