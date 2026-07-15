import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { LedgerConfig } from "./config.js";
import type { Database } from "./database.js";
import type { RegistrationContact } from "./dynadot.js";

export interface DomainLedgerRecord {
  id: string;
  domainName: string;
  customerId?: string;
  x402Payer?: string;
  years: number;
  currency?: string;
  paymentId: string;
  registrationContact?: RegistrationContact;
  dynadotRegistration: unknown;
  payment: unknown;
  domainPush?: DomainPushRecord;
  createdAt: string;
  updatedAt: string;
}

export interface DomainPushRecord {
  status: "requested";
  targetAccount?: string;
  targetEmail?: string;
  dynadotPush: unknown;
  requestedAt: string;
}

interface StoreShape {
  records: DomainLedgerRecord[];
}

export class DomainLedger {
  private readonly config: LedgerConfig;
  private readonly database?: Database;

  constructor(config: LedgerConfig, database?: Database) {
    this.config = config;
    this.database = database;
  }

  async createRecord(input: {
    domainName: string;
    customerId?: string;
    x402Payer?: string;
    years: number;
    currency?: string;
    paymentId: string;
    registrationContact?: RegistrationContact;
    dynadotRegistration: unknown;
    payment: unknown;
  }) {
    const store = await this.readStore();
    const now = new Date().toISOString();
    const record: DomainLedgerRecord = {
      id: crypto.randomUUID(),
      domainName: this.normalizeDomain(input.domainName),
      customerId: input.customerId ? this.normalizeCustomerId(input.customerId) : undefined,
      x402Payer: input.x402Payer ? this.normalizeCustomerId(input.x402Payer) : undefined,
      years: input.years,
      currency: input.currency,
      paymentId: input.paymentId,
      registrationContact: input.registrationContact,
      dynadotRegistration: input.dynadotRegistration,
      payment: input.payment,
      createdAt: now,
      updatedAt: now
    };

    store.records.push(record);
    await this.writeStore(store);

    return record;
  }

  async listRecords(filter: { domainName?: string; customerId?: string; paymentId?: string } = {}) {
    const store = await this.readStore();
    const normalizedDomain = filter.domainName ? this.normalizeDomain(filter.domainName) : undefined;
    const normalizedCustomerId = filter.customerId ? this.normalizeCustomerId(filter.customerId) : undefined;

    return store.records.filter((record) => {
      if (normalizedDomain && record.domainName !== normalizedDomain) {
        return false;
      }

      if (normalizedCustomerId && record.customerId !== normalizedCustomerId) {
        return false;
      }

      if (filter.paymentId && record.paymentId !== filter.paymentId) {
        return false;
      }

      return true;
    });
  }

  async getRecordByDomain(domainName: string, customerId?: string) {
    const records = await this.listRecords({ domainName, customerId });
    return records.at(-1) ?? null;
  }

  async recordDomainPush(input: {
    domainName: string;
    customerId?: string;
    targetAccount?: string;
    targetEmail?: string;
    dynadotPush: unknown;
  }) {
    const store = await this.readStore();
    const normalizedDomain = this.normalizeDomain(input.domainName);
    const normalizedCustomerId = input.customerId ? this.normalizeCustomerId(input.customerId) : undefined;

    let index = -1;

    for (let recordIndex = store.records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      const record = store.records[recordIndex];

      if (record.domainName === normalizedDomain && (!normalizedCustomerId || record.customerId === normalizedCustomerId)) {
        index = recordIndex;
        break;
      }
    }

    if (index === -1) {
      throw new Error(`No ledger record found for ${normalizedDomain}.`);
    }

    const now = new Date().toISOString();
    const record = store.records[index];
    const updated: DomainLedgerRecord = {
      ...record,
      domainPush: {
        status: "requested",
        targetAccount: input.targetAccount,
        targetEmail: input.targetEmail,
        dynadotPush: input.dynadotPush,
        requestedAt: now
      },
      updatedAt: now
    };

    store.records[index] = updated;
    await this.writeStore(store);

    return updated;
  }

  private async readStore(): Promise<StoreShape> {
    if (this.database?.enabled) {
      const result = await this.database.query<{ record: DomainLedgerRecord }>(
        "select record from oyira_domain_ledger order by created_at asc"
      );
      return { records: result.rows.map((row) => row.record) };
    }

    try {
      const raw = await readFile(this.config.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;

      return {
        records: Array.isArray(parsed.records) ? parsed.records : []
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { records: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    if (this.database?.enabled) {
      for (const record of store.records) {
        await this.database.query(
          `insert into oyira_domain_ledger
             (id, domain_name, customer_id, x402_payer, payment_id, record, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           on conflict (id) do update set
             domain_name = excluded.domain_name,
             customer_id = excluded.customer_id,
             x402_payer = excluded.x402_payer,
             payment_id = excluded.payment_id,
             record = excluded.record,
             updated_at = excluded.updated_at`,
          [
            record.id,
            record.domainName,
            record.customerId ?? null,
            record.x402Payer ?? null,
            record.paymentId ?? null,
            JSON.stringify(record),
            record.createdAt,
            record.updatedAt
          ]
        );
      }
      return;
    }

    await mkdir(path.dirname(this.config.storePath), { recursive: true });
    await writeFile(this.config.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private normalizeDomain(domainName: string) {
    return domainName.trim().toLowerCase();
  }

  private normalizeCustomerId(customerId: string) {
    return customerId.trim().toLowerCase();
  }
}
