import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';

let count = 0;
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${item.name}`;
    if (item.isDirectory()) {
      await walk(file);
      continue;
    }
    assert.ok(!item.isSymbolicLink(), `No asset symlinks: ${file}`);
    const metadata = await stat(file);
    assert.ok(
      metadata.size <= 25 * 1024 * 1024,
      `Asset exceeds Cloudflare 25 MiB limit: ${file}`,
    );
    assert.ok(
      !/(^|\/)\.(?:env|git|dev.vars)/.test(file),
      `Private file in assets: ${file}`,
    );
    count++;
  }
}
await walk('dist');
assert.ok(count <= 20000, 'Asset count exceeds supported baseline');
const html = await readFile('dist/index.html', 'utf8');
assert.ok(
  !html.includes('/@vite/client') && !html.includes('/src/main.js'),
  'Built HTML required',
);
await stat('dist/cesium/Cesium.js');
await stat('dist/cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg');
console.log(
  JSON.stringify({
    productionAssets: count,
    maximumAssetSizeMiB: 25,
    buildValidation: 'passed',
  }),
);
