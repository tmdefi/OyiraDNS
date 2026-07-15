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

Check `GET /ready`. It should show:

```json
{
  "storageMode": "postgres"
}
```

If no database URL is configured, Oyira falls back to local JSON files.
