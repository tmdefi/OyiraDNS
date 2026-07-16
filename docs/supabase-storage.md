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

Public agents should start with `GET /agent/manifest`, then use `POST /public/domain-check`, `POST /agent/brand-discovery`, and `POST /x402/domain/purchase`. No owner token is required for any public path.
