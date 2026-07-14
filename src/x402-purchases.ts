import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { X402Config } from "./config.js";
import type { RegistrationContact } from "./dynadot.js";

export interface X402PurchaseRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  domainName: string;
  years: number;
  quoteId: string;
  customerId?: string;
  registrationContact?: RegistrationContact;
  status: "challenge_created" | "payment_settled" | "registered" | "failed";
  paymentTransaction?: string;
  ledgerRecordId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoreShape {
  purchases: X402PurchaseRecord[];
}

export class X402PurchaseStore {
  constructor(private readonly config: X402Config) {}

  async getByIdempotencyKey(idempotencyKey: string) {
    const store = await this.readStore();
    return store.purchases.find((purchase) => purchase.idempotencyKey === idempotencyKey) ?? null;
  }

  async create(input: {
    idempotencyKey: string;
    requestHash: string;
    domainName: string;
    years: number;
    quoteId: string;
    customerId?: string;
    registrationContact?: RegistrationContact;
  }) {
    const store = await this.readStore();
    const existing = store.purchases.find((purchase) => purchase.idempotencyKey === input.idempotencyKey);

    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new Error("Idempotency key already belongs to a different x402 purchase request.");
      }

      return existing;
    }

    const now = new Date().toISOString();
    const record: X402PurchaseRecord = {
      id: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      domainName: input.domainName,
      years: input.years,
      quoteId: input.quoteId,
      customerId: input.customerId,
      registrationContact: input.registrationContact,
      status: "challenge_created",
      createdAt: now,
      updatedAt: now
    };

    store.purchases.push(record);
    await this.writeStore(store);

    return record;
  }

  async update(idempotencyKey: string, patch: Partial<X402PurchaseRecord>) {
    const store = await this.readStore();
    const index = store.purchases.findIndex((purchase) => purchase.idempotencyKey === idempotencyKey);

    if (index === -1) {
      throw new Error(`x402 purchase not found: ${idempotencyKey}.`);
    }

    const updated = {
      ...store.purchases[index],
      ...patch,
      updatedAt: new Date().toISOString()
    };
    store.purchases[index] = updated;
    await this.writeStore(store);

    return updated;
  }

  private async readStore(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.config.purchaseStorePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return { purchases: Array.isArray(parsed.purchases) ? parsed.purchases : [] };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { purchases: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    await mkdir(path.dirname(this.config.purchaseStorePath), { recursive: true });
    await writeFile(this.config.purchaseStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

export function hashX402PurchaseRequest(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }

  return value;
}
