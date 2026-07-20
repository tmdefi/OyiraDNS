# Supabase Storage

Oyira can store production records in Supabase Postgres instead of Railway's ephemeral filesystem.

Set one of these Railway variables:

```env
SUPABASE_DB_URL=postgresql://...
DATABASE_SSL=true
```

Use the Supabase pooled Postgres connection string, not the direct database connection string. The direct Supabase DB host may resolve to IPv6-only addresses, which some Railway runtimes cannot reach.

In Supabase, copy the connection string from:

```txt
Project Settings -> Database -> Connection pooling
```

The pooler hostname usually contains `pooler.supabase.com`. `DATABASE_URL` or `POSTGRES_URL` also work if those are easier to manage.

When a database URL is present, Oyira automatically creates these tables on first use:

- `oyira_quotes`
- `oyira_x402_purchases`
- `oyira_domain_ledger`
- `oyira_audit_log`
- `oyira_user_api_keys`
- `oyira_sessions`
- `oyira_domain_monitors`

Check `GET /ready`. It should show:

```json
{
  "storageMode": "postgres"
}
```

If no database URL is configured, Oyira falls back to local JSON files.

For x402 purchase safety, unpaid purchase challenges are stored with `status: "challenge_created"` and are marked `status: "expired"` if the linked quote expires before payment.

Use `POST /agent/x402/purchase-readiness` to check live-purchase readiness before attempting x402 payment. It validates registration contact shape, quote freshness, Dynadot balance coverage, durable x402 storage, and the live-purchase flag.

Use `POST /agent/brand-discovery` to generate brandable base-name ideas and check configured TLD availability/pricing in real time. This endpoint is public, safe, and never creates payment or registration.

Public clients should call these endpoints through a structured HTTP client or tool, send JSON request bodies, and parse JSON responses directly. Avoid shell pipelines such as `curl | python` and avoid decorative emoji in inline scripts. For a brand-only request such as `BondiBark`, use `POST /agent/brand-discovery` first or explicitly state the default TLD assumption before normalizing it to a full domain such as `bondibark.xyz` for a 10-year quote.

For domain purchases, collect the user's own real registration details before payment: `registrantName`, `email`, `phone`, `address`, `city`, `country`, and `postalCode`. `phoneCountryCode`, `state`, and `organization` are optional. `zipCode` is accepted as an alias for `postalCode`; masked placeholders such as `+141****0100` are rejected.

Successful x402 domain purchases return customerAccess.customerId and a one-time customerAccess.apiKey. Store that key and send it as Authorization: Bearer <apiKey> for future DNS, nameserver, project-link, and domain-management actions. Buying agents should never ask customers for API_AUTH_TOKEN; that is the Railway owner/admin token.
For older purchases that did not return `customerAccess.apiKey`, recover access without owner/admin secrets: call `POST /auth/recover-access/challenge` with `{ "domainName": "tmdefi.xyz" }`, ask the user to sign the exact returned `message` field with the wallet that paid for the x402 purchase, not `challengeId`, then call `POST /auth/recover-access/verify` with `challengeId` and `signature`. Oyira verifies the signer against the ledger `x402Payer` and returns a new customer API key.
For Vercel, use `POST /agent/actions/link-project` with `Authorization: Bearer <customerAccess.apiKey>` and body `{ "confirm": true, "domainName": "tmdefi.xyz", "provider": "vercel" }`. If the key is not in context, ask the user for their `customerAccess.apiKey` from the purchase response. Do not ask for Dynadot login or `API_AUTH_TOKEN` unless the user explicitly wants a manual/admin fallback.

Public agents should start with `GET /agent/manifest`, then use `POST /public/domain-check`, `POST /agent/brand-discovery`, and `POST /x402/domain/purchase`. No owner token is required for any public path. Public x402 payments use `USD₮0` on X Layer (chain 196).






