import { appendFile, mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { AuditConfig } from "./config.js";
import type { Database } from "./database.js";

export interface AuditEvent {
  action: string;
  status: "attempt" | "success" | "failure";
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export class AuditLog {
  constructor(
    private readonly config: AuditConfig,
    private readonly database?: Database
  ) {}

  async append(event: AuditEvent) {
    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...event
    };

    if (this.database?.enabled) {
      await this.database.insertAuditEvent(entry);
    } else {
      await mkdir(path.dirname(this.config.logPath), { recursive: true });
      await appendFile(this.config.logPath, `${JSON.stringify(entry)}\n`, "utf8");
    }

    return entry;
  }
}
