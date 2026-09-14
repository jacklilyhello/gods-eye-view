import { api, accountPath, inspect } from './cloudflare-api.mjs';

await inspect('infrastructure-initial');
// Listing tokens does not prove creation permission. This short-lived probe is
// never attached to an Access policy, so it grants access to no application.
const token = await api(`${accountPath}/access/service_tokens`, {
  method: 'POST',
  body: {
    name: `gods-permission-probe-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    duration: '5m',
  },
});
console.log(`::add-mask::${token.client_id}`);
console.log(`::add-mask::${token.client_secret}`);
await api(`${accountPath}/access/service_tokens/${token.id}`, {
  method: 'DELETE',
});
console.log('Access service-token creation and cleanup permissions verified');
