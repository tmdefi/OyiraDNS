import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionConfig } from "./config.js";

export interface OyiraSessionMessage {
  role: "customer" | "oyira";
  text: string;
  createdAt: string;
}

export interface OyiraSession {
  id: string;
  customerId?: string;
  lastDomainName?: string;
  lastQuoteId?: string;
  lastPaymentId?: string;
  lastToolName?: string;
  messages: OyiraSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

interface StoreShape {
  sessions: OyiraSession[];
}

export class OyiraSessionStore {
  constructor(private readonly config: SessionConfig) {}

  async getOrCreateSession(input: { sessionId?: string; customerId?: string }) {
    const store = await this.readStore();
    const sessionId = input.sessionId || input.customerId || "default";
    const existing = store.sessions.find((session) => session.id === sessionId);

    if (existing) {
      if (input.customerId && !existing.customerId) {
        existing.customerId = input.customerId;
        existing.updatedAt = new Date().toISOString();
        await this.writeStore(store);
      }

      return existing;
    }

    const now = new Date().toISOString();
    const session: OyiraSession = {
      id: sessionId,
      customerId: input.customerId,
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    store.sessions.push(session);
    await this.writeStore(store);

    return session;
  }

  async updateSession(sessionId: string, patch: Partial<Omit<OyiraSession, "id" | "createdAt">>) {
    const store = await this.readStore();
    const index = store.sessions.findIndex((session) => session.id === sessionId);

    if (index === -1) {
      throw new Error(`Oyira session not found: ${sessionId}.`);
    }

    const current = store.sessions[index];
    const updated: OyiraSession = {
      ...current,
      ...patch,
      messages: patch.messages ?? current.messages,
      updatedAt: new Date().toISOString()
    };

    store.sessions[index] = updated;
    await this.writeStore(store);

    return updated;
  }

  async listSessions() {
    return (await this.readStore()).sessions;
  }

  private async readStore(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.config.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;

      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { sessions: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    await mkdir(path.dirname(this.config.storePath), { recursive: true });
    await writeFile(this.config.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}
