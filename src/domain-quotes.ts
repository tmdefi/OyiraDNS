import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { QuoteConfig } from "./config.js";
import type { Database } from "./database.js";
import type { DynadotClient } from "./dynadot.js";
import type { CreatePaymentResult, OkxPaymentClient } from "./okx.js";

export interface DomainQuote {
  id: string;
  domainName: string;
  years: number;
  currency: string;
  paymentSymbol: string;
  available: boolean | null;
  dynadotCost: string;
  serviceFee: string;
  totalDue: string;
  expiresAt: string;
  status: "quoted" | "payment_created" | "expired";
  pricingSource: "dynadot_search";
  pricingWarning?: string;
  availability: unknown;
  tldPrice: unknown;
  payment?: CreatePaymentResult;
  createdAt: string;
  updatedAt: string;
}

export class DomainUnavailableError extends Error {
  constructor(readonly domainName: string) {
    super(`Domain ${domainName} is not available.`);
    this.name = "DomainUnavailableError";
  }
}

interface StoreShape {
  quotes: DomainQuote[];
}

export class DomainQuoteService {
  private readonly config: QuoteConfig;
  private readonly dynadot: DynadotClient;
  private readonly okx: OkxPaymentClient;
  private readonly database?: Database;

  constructor(config: QuoteConfig, dynadot: DynadotClient, okx: OkxPaymentClient, database?: Database) {
    this.config = config;
    this.dynadot = dynadot;
    this.okx = okx;
    this.database = database;
  }

  async createQuote(input: {
    domainName: string;
    years?: number;
    currency?: string;
    paymentSymbol?: string;
    serviceFeeAmount?: string;
  }) {
    const domainName = this.normalizeDomain(input.domainName);
    const years = input.years ?? 1;
    const currency = input.currency ?? this.config.defaultCurrency;
    const paymentSymbol = input.paymentSymbol ?? this.config.paymentSymbol;
    const serviceFee = this.formatAmount(input.serviceFeeAmount ?? (this.config.serviceFeeAmount || "0"));
    const availability = await this.dynadot.searchDomain(domainName, { showPrice: true, currency });
    const available = this.extractAvailability(availability);
    const tld = domainName.includes(".") ? domainName.split(".").at(-1) ?? domainName : domainName;
    if (available === false) {
      throw new DomainUnavailableError(domainName);
    }

    const dynadotCost = this.extractRegistrationPrice(availability, years) ?? "";
    let tldPrice: unknown = null;
    let pricingWarning: string | undefined;

    if (!dynadotCost) {
      throw new Error(
        `Could not determine Dynadot registration price for ${domainName}. The search response with showPrice=yes did not include a usable domain-specific registration price.`
      );
    }

    try {
      tldPrice = await this.dynadot.getTldPrice(tld, currency);
    } catch (error) {
      pricingWarning = error instanceof Error ? error.message : String(error);
    }

    const now = new Date();
    const quote: DomainQuote = {
      id: `quote_${crypto.randomUUID()}`,
      domainName,
      years,
      currency,
      paymentSymbol,
      available,
      dynadotCost: this.formatAmount(dynadotCost),
      serviceFee,
      totalDue: this.formatAmount(this.addAmounts(dynadotCost, serviceFee)),
      expiresAt: new Date(now.getTime() + this.config.ttlSeconds * 1000).toISOString(),
      status: "quoted",
      pricingSource: "dynadot_search",
      pricingWarning,
      availability,
      tldPrice,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    const store = await this.readStore();
    store.quotes.push(quote);
    await this.writeStore(store);

    return quote;
  }

  async searchVariants(input: { name: string; tlds?: string[]; currency?: string; showPrice?: boolean }) {
    const baseName = this.normalizeBaseName(input.name);
    const currency = input.currency ?? this.config.defaultCurrency;
    const tlds = (input.tlds && input.tlds.length > 0 ? input.tlds : this.config.defaultTlds).map((tld) =>
      tld.trim().replace(/^\./, "").toLowerCase()
    );

    const results = await Promise.all(
      tlds.map(async (tld) => {
        const domainName = `${baseName}.${tld}`;

        try {
          const response = await this.dynadot.searchDomain(domainName, {
            showPrice: input.showPrice ?? true,
            currency
          });

          return {
            domainName,
            ok: true,
            available: this.extractAvailability(response),
            registrationPrice: this.extractRegistrationPrice(response, 1),
            response
          };
        } catch (error) {
          return {
            domainName,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    return {
      name: baseName,
      currency,
      tlds,
      results
    };
  }

  async createPaymentFromQuote(input: { quoteId: string; recipient: string; description?: string; externalId?: string }) {
    const quote = await this.getQuote(input.quoteId);
    const usableQuote = await this.assertQuoteUsable(input.quoteId, quote);

    if (usableQuote.payment) {
      throw new Error(`Quote ${usableQuote.id} already has a payment request.`);
    }

    const payment = await this.okx.createPayment({
      amount: usableQuote.totalDue,
      symbol: usableQuote.paymentSymbol,
      recipient: input.recipient,
      description: input.description ?? `Register ${usableQuote.domainName}`,
      externalId: input.externalId ?? usableQuote.id
    });

    return this.updateQuote(usableQuote.id, {
      status: "payment_created",
      payment,
      updatedAt: new Date().toISOString()
    });
  }

  async getQuote(quoteId: string) {
    const store = await this.readStore();
    return store.quotes.find((quote) => quote.id === quoteId) ?? null;
  }

  async assertQuoteUsable(quoteId: string, quote?: DomainQuote | null) {
    const resolvedQuote = quote ?? (await this.getQuote(quoteId));

    if (!resolvedQuote) {
      throw new Error(`Quote ${quoteId} was not found.`);
    }

    if (new Date(resolvedQuote.expiresAt).getTime() <= Date.now()) {
      await this.updateQuote(resolvedQuote.id, { status: "expired" });
      throw new Error(`Quote ${resolvedQuote.id} expired at ${resolvedQuote.expiresAt}.`);
    }

    if (resolvedQuote.available === false) {
      throw new Error(`Domain ${resolvedQuote.domainName} is not available.`);
    }

    return resolvedQuote;
  }

  async listQuotes(filter: { domainName?: string; status?: DomainQuote["status"] } = {}) {
    const store = await this.readStore();
    const normalizedDomain = filter.domainName ? this.normalizeDomain(filter.domainName) : undefined;

    return store.quotes.filter((quote) => {
      if (normalizedDomain && quote.domainName !== normalizedDomain) {
        return false;
      }

      if (filter.status && quote.status !== filter.status) {
        return false;
      }

      return true;
    });
  }

  private async updateQuote(quoteId: string, patch: Partial<DomainQuote>) {
    const store = await this.readStore();
    const index = store.quotes.findIndex((quote) => quote.id === quoteId);

    if (index === -1) {
      throw new Error(`Quote ${quoteId} was not found.`);
    }

    const updated = { ...store.quotes[index], ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    store.quotes[index] = updated;
    await this.writeStore(store);

    return updated;
  }

  private async readStore(): Promise<StoreShape> {
    if (this.database?.enabled) {
      const result = await this.database.query<{ record: DomainQuote }>("select record from oyira_quotes order by created_at asc");
      return { quotes: result.rows.map((row) => row.record) };
    }

    try {
      const raw = await readFile(this.config.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;

      return {
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : []
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { quotes: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    if (this.database?.enabled) {
      for (const quote of store.quotes) {
        await this.database.query(
          `insert into oyira_quotes (id, domain_name, status, record, created_at, updated_at)
           values ($1, $2, $3, $4::jsonb, $5, $6)
           on conflict (id) do update set
             domain_name = excluded.domain_name,
             status = excluded.status,
             record = excluded.record,
             updated_at = excluded.updated_at`,
          [quote.id, quote.domainName, quote.status, JSON.stringify(quote), quote.createdAt, quote.updatedAt]
        );
      }
      return;
    }

    await mkdir(path.dirname(this.config.storePath), { recursive: true });
    await writeFile(this.config.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private extractAvailability(response: unknown): boolean | null {
    const directAvailability = this.findAvailabilityValue(response);

    if (directAvailability !== null) {
      return directAvailability;
    }

    const values = this.flatten(response);
    const unavailableHints = ["unavailable", "taken", "not available", "false"];
    const availableHints = ["available", "true", "yes"];

    for (const value of values) {
      const normalized = value.toLowerCase();
      if (unavailableHints.some((hint) => normalized === hint || normalized.includes(hint))) {
        return false;
      }
    }

    for (const value of values) {
      const normalized = value.toLowerCase();
      if (availableHints.some((hint) => normalized === hint || normalized.includes(hint))) {
        return true;
      }
    }

    return null;
  }

  private findAvailabilityValue(response: unknown): boolean | null {
    const queue: unknown[] = [response];

    while (queue.length > 0) {
      const value = queue.shift();

      if (!value || typeof value !== "object") {
        continue;
      }

      if (Array.isArray(value)) {
        queue.push(...value);
        continue;
      }

      for (const [key, entry] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");

        if (["available", "availability", "avail"].includes(normalizedKey)) {
          const normalizedValue = String(entry).trim().toLowerCase();

          if (["yes", "true", "available"].includes(normalizedValue)) {
            return true;
          }

          if (["no", "false", "unavailable", "taken", "not available"].includes(normalizedValue)) {
            return false;
          }
        }

        if (entry && typeof entry === "object") {
          queue.push(entry);
        }
      }
    }

    return null;
  }

  private extractPrice(response: unknown): string | null {
    const candidateKeys = new Set([
      "price",
      "register",
      "registration",
      "registrationfee",
      "registrationprice",
      "registerfee",
      "registerprice",
      "regfee",
      "regprice"
    ]);
    const queue: unknown[] = [response];

    while (queue.length > 0) {
      const value = queue.shift();
      if (!value || typeof value !== "object") {
        continue;
      }

      if (Array.isArray(value)) {
        queue.push(...value);
        continue;
      }

      for (const [key, entry] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
        if (candidateKeys.has(normalizedKey) && (typeof entry === "string" || typeof entry === "number")) {
          const amount = this.parseAmountLoose(String(entry));
          if (amount > 0) {
            return String(amount);
          }
        }

        if (entry && typeof entry === "object") {
          queue.push(entry);
        }
      }
    }

    return null;
  }

  private extractRegistrationPrice(response: unknown, years: number): string | null {
    const priceList = this.findPriceList(response);

    if (priceList) {
      const exactPrice = this.findPriceForYears(priceList, years);

      if (exactPrice) {
        return exactPrice;
      }
    }

    return this.extractPrice(response);
  }

  private findPriceList(response: unknown): unknown[] | null {
    const queue: unknown[] = [response];

    while (queue.length > 0) {
      const value = queue.shift();
      if (!value || typeof value !== "object") {
        continue;
      }

      if (Array.isArray(value)) {
        queue.push(...value);
        continue;
      }

      for (const [key, entry] of Object.entries(value)) {
        if (key.toLowerCase() === "price_list" && Array.isArray(entry)) {
          return entry;
        }

        if (entry && typeof entry === "object") {
          queue.push(entry);
        }
      }
    }

    return null;
  }

  private findPriceForYears(priceList: unknown[], years: number): string | null {
    for (const priceEntry of priceList) {
      if (!priceEntry || typeof priceEntry !== "object" || Array.isArray(priceEntry)) {
        continue;
      }

      const entry = priceEntry as Record<string, unknown>;
      const unit = typeof entry.unit === "string" ? entry.unit : "";
      const unitYears = this.extractYearsFromUnit(unit);

      if (unitYears === years && (typeof entry.registration_price === "string" || typeof entry.registration_price === "number")) {
        return String(this.parseAmountLoose(String(entry.registration_price)));
      }
    }

    return null;
  }

  private extractYearsFromUnit(unit: string) {
    const match = unit.match(/price\/(\d+)\s*year/i);
    return match ? Number(match[1]) : null;
  }

  private flatten(value: unknown): string[] {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }

    if (Array.isArray(value)) {
      return value.flatMap((entry) => this.flatten(entry));
    }

    if (value && typeof value === "object") {
      return Object.values(value).flatMap((entry) => this.flatten(entry));
    }

    return [];
  }

  private addAmounts(left: string, right: string) {
    return String(this.parseAmount(left) + this.parseAmount(right));
  }

  private multiplyAmount(amount: string, multiplier: number) {
    return String(this.parseAmount(amount) * multiplier);
  }

  private parseAmount(amount: string) {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    return parsed;
  }

  private parseAmountLoose(amount: string) {
    return this.parseAmount(amount.replace(/[^0-9.]/g, ""));
  }

  private formatAmount(amount: string) {
    return this.parseAmount(amount).toFixed(2);
  }

  private normalizeDomain(domainName: string) {
    return domainName.trim().toLowerCase();
  }

  private normalizeBaseName(name: string) {
    const trimmed = name.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    return trimmed.includes(".") ? trimmed.split(".")[0] : trimmed;
  }
}
