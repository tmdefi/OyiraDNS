import { Pool, type QueryResultRow } from "pg";
import type { DatabaseConfig } from "./config.js";

export class Database {
  private readonly pool: Pool | null;
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly config: DatabaseConfig) {
    this.pool = config.url
      ? new Pool({
          connectionString: config.url,
          ssl: config.ssl ? { rejectUnauthorized: false } : undefined
        })
      : null;
  }

  get enabled() {
    return Boolean(this.pool);
  }

  async ping() {
    if (!this.pool) {
      return false;
    }

    await this.query("select 1");
    return true;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    if (!this.pool) {
      throw new Error("Database is not configured.");
    }

    await this.ensureSchema();
    return this.pool.query<T>(text, values);
  }

  async insertAuditEvent(entry: Record<string, unknown>) {
    await this.query(
      `insert into oyira_audit_log (id, action, status, request, result, error, entry, created_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)`,
      [
        entry.id,
        entry.action,
        entry.status,
        JSON.stringify(entry.request ?? null),
        JSON.stringify(entry.result ?? null),
        entry.error ?? null,
        JSON.stringify(entry),
        entry.createdAt
      ]
    );
  }

  private async ensureSchema() {
    if (!this.pool) {
      return;
    }

    if (!this.schemaReady) {
      this.schemaReady = this.createSchema();
    }

    return this.schemaReady;
  }

  private async createSchema() {
    if (!this.pool) {
      return;
    }

    await this.pool.query(`
      create table if not exists oyira_quotes (
        id text primary key,
        domain_name text not null,
        status text not null,
        record jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      create index if not exists oyira_quotes_domain_name_idx on oyira_quotes (domain_name);
      create index if not exists oyira_quotes_status_idx on oyira_quotes (status);

      create table if not exists oyira_x402_purchases (
        idempotency_key text primary key,
        id text not null,
        domain_name text not null,
        customer_id text,
        x402_payer text,
        status text not null,
        record jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      create unique index if not exists oyira_x402_purchases_id_idx on oyira_x402_purchases (id);
      create index if not exists oyira_x402_purchases_domain_name_idx on oyira_x402_purchases (domain_name);
      create index if not exists oyira_x402_purchases_customer_id_idx on oyira_x402_purchases (customer_id);
      create index if not exists oyira_x402_purchases_x402_payer_idx on oyira_x402_purchases (x402_payer);
      create index if not exists oyira_x402_purchases_status_idx on oyira_x402_purchases (status);

      create table if not exists oyira_domain_ledger (
        id text primary key,
        domain_name text not null,
        customer_id text,
        x402_payer text,
        payment_id text,
        record jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      create index if not exists oyira_domain_ledger_domain_name_idx on oyira_domain_ledger (domain_name);
      create index if not exists oyira_domain_ledger_customer_id_idx on oyira_domain_ledger (customer_id);
      create index if not exists oyira_domain_ledger_x402_payer_idx on oyira_domain_ledger (x402_payer);
      create index if not exists oyira_domain_ledger_payment_id_idx on oyira_domain_ledger (payment_id);

      create table if not exists oyira_audit_log (
        id text primary key,
        action text not null,
        status text not null,
        request jsonb,
        result jsonb,
        error text,
        entry jsonb not null,
        created_at timestamptz not null
      );

      create index if not exists oyira_audit_log_action_idx on oyira_audit_log (action);
      create index if not exists oyira_audit_log_status_idx on oyira_audit_log (status);
      create index if not exists oyira_audit_log_created_at_idx on oyira_audit_log (created_at);
    `);
  }
}
