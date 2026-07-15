import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MonitoringConfig } from "./config.js";
import type { Database } from "./database.js";
import type { DynadotClient } from "./dynadot.js";

type Availability = "Yes" | "No" | "Unknown";

export interface DomainMonitor {
  domainName: string;
  customerId?: string;
  alertWhenAvailable: boolean;
  lastAvailability: Availability | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainMonitorCheckResult {
  domainName: string;
  customerId?: string;
  previousAvailability: Availability | null;
  currentAvailability: Availability;
  changed: boolean;
  shouldNotify: boolean;
  raw: unknown;
}

interface StoreShape {
  monitors: DomainMonitor[];
}

export class DomainMonitorService {
  constructor(
    private readonly config: MonitoringConfig,
    private readonly dynadot: DynadotClient,
    private readonly database?: Database
  ) {}

  async addMonitor(input: { domainName: string; alertWhenAvailable?: boolean; customerId?: string }) {
    const store = await this.readStore();
    const normalizedDomain = this.normalizeDomain(input.domainName);
    const normalizedCustomerId = input.customerId ? this.normalizeCustomerId(input.customerId) : undefined;
    const now = new Date().toISOString();
    const existing = store.monitors.find(
      (monitor) =>
        monitor.domainName === normalizedDomain &&
        (!normalizedCustomerId || monitor.customerId === normalizedCustomerId)
    );

    if (existing) {
      existing.alertWhenAvailable = input.alertWhenAvailable ?? true;
      existing.customerId = normalizedCustomerId ?? existing.customerId;
      existing.updatedAt = now;
      await this.writeStore(store);
      return existing;
    }

    const monitor: DomainMonitor = {
      domainName: normalizedDomain,
      customerId: normalizedCustomerId,
      alertWhenAvailable: input.alertWhenAvailable ?? true,
      lastAvailability: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now
    };

    store.monitors.push(monitor);
    await this.writeStore(store);

    return monitor;
  }

  async monitorDomainForCustomer(input: { domainName: string; customerId?: string; alertWhenAvailable?: boolean }) {
    const monitor = await this.addMonitor(input);

    return {
      monitor,
      nextAction: "Monitor is ready. Poll check_domain_monitor or check_all_domain_monitors to detect changes."
    };
  }

  async listMonitors() {
    return (await this.readStore()).monitors;
  }

  async removeMonitor(domainName: string, customerId?: string) {
    const store = await this.readStore();
    const normalizedDomain = this.normalizeDomain(domainName);
    const normalizedCustomerId = customerId ? this.normalizeCustomerId(customerId) : undefined;
    const beforeCount = store.monitors.length;
    store.monitors = store.monitors.filter((monitor) => {
      if (monitor.domainName !== normalizedDomain) {
        return true;
      }

      if (normalizedCustomerId && monitor.customerId !== normalizedCustomerId) {
        return true;
      }

      return false;
    });
    await this.writeStore(store);

    return { removed: beforeCount !== store.monitors.length };
  }

  async checkMonitor(domainName: string, customerId?: string) {
    const store = await this.readStore();
    const normalizedDomain = this.normalizeDomain(domainName);
    const normalizedCustomerId = customerId ? this.normalizeCustomerId(customerId) : undefined;
    const monitor = store.monitors.find(
      (entry) =>
        entry.domainName === normalizedDomain &&
        (!normalizedCustomerId || entry.customerId === normalizedCustomerId)
    );

    if (!monitor) {
      throw new Error(`Domain monitor not found: ${normalizedDomain}.`);
    }

    const result = await this.checkOne(monitor);
    await this.writeStore(store);

    return result;
  }

  async checkAll() {
    const store = await this.readStore();
    const results: DomainMonitorCheckResult[] = [];

    for (const monitor of store.monitors) {
      results.push(await this.checkOne(monitor));
    }

    await this.writeStore(store);

    return results;
  }

  private async checkOne(monitor: DomainMonitor): Promise<DomainMonitorCheckResult> {
    const raw = await this.dynadot.searchDomain(monitor.domainName, {
      showPrice: true,
      currency: this.config.defaultCurrency
    });
    const currentAvailability = this.extractAvailability(raw);
    const previousAvailability = monitor.lastAvailability;
    const changed = previousAvailability !== null && previousAvailability !== currentAvailability;
    const shouldNotify =
      (monitor.alertWhenAvailable && currentAvailability === "Yes" && previousAvailability !== "Yes") || changed;

    monitor.lastAvailability = currentAvailability;
    monitor.lastCheckedAt = new Date().toISOString();
    monitor.updatedAt = monitor.lastCheckedAt;

    return {
      domainName: monitor.domainName,
      customerId: monitor.customerId,
      previousAvailability,
      currentAvailability,
      changed,
      shouldNotify,
      raw
    };
  }

  private extractAvailability(raw: unknown): Availability {
    if (!raw || typeof raw !== "object") {
      return "Unknown";
    }

    const data = (raw as Record<string, unknown>).data;
    if (!data || typeof data !== "object") {
      return "Unknown";
    }

    const available = (data as Record<string, unknown>).available;
    if (available === "Yes" || available === "No") {
      return available;
    }

    return "Unknown";
  }

  private async readStore(): Promise<StoreShape> {
    if (this.database?.enabled) {
      const result = await this.database.query<{ record: DomainMonitor }>(
        "select record from oyira_domain_monitors order by created_at asc"
      );
      return { monitors: result.rows.map((row) => row.record) };
    }

    try {
      const raw = await readFile(this.config.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return {
        monitors: Array.isArray(parsed.monitors) ? parsed.monitors : []
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { monitors: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    if (this.database?.enabled) {
      const seen = new Set<string>();
      for (const monitor of store.monitors) {
        const customerId = monitor.customerId ?? "";
        seen.add(`${monitor.domainName}\u0000${customerId}`);
        await this.database.query(
          `insert into oyira_domain_monitors (domain_name, customer_id, record, created_at, updated_at)
           values ($1, $2, $3::jsonb, $4, $5)
           on conflict (domain_name, customer_id) do update set
             record = excluded.record,
             updated_at = excluded.updated_at`,
          [monitor.domainName, customerId, JSON.stringify(monitor), monitor.createdAt, monitor.updatedAt]
        );
      }

      const existing = await this.database.query<{ domain_name: string; customer_id: string }>(
        "select domain_name, customer_id from oyira_domain_monitors"
      );
      for (const row of existing.rows) {
        if (!seen.has(`${row.domain_name}\u0000${row.customer_id}`)) {
          await this.database.query("delete from oyira_domain_monitors where domain_name = $1 and customer_id = $2", [
            row.domain_name,
            row.customer_id
          ]);
        }
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
