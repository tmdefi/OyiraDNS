# Supabase Storage

Oyira can store production records in Supabase Postgres instead of Railway's ephemeral filesystem.

Set one of these Railway variables:

```env
SUPABASE_DB_URL=postgresql://...
DATABASE_SSL=true
```

`SUPABASE_DB_URL` can be the Supabase pooled Postgres connection string. `DATABASE_URL` or `POSTGRES_URL` also work if those are easier to manage.

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
