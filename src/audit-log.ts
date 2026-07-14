import { appendFile, mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { AuditConfig } from "./config.js";

export interface AuditEvent {
  action: string;
  status: "attempt" | "success" | "failure";
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export class AuditLog {
  constructor(private readonly config: AuditConfig) {}

  async append(event: AuditEvent) {
    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...event
    };

    await mkdir(path.dirname(this.config.logPath), { recursive: true });
    await appendFile(this.config.logPath, `${JSON.stringify(entry)}\n`, "utf8");

    return entry;
  }
}
