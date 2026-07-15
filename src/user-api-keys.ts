import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthConfig, UserApiKey } from "./config.js";
import type { Database } from "./database.js";

export interface StoredUserApiKey {
  id: string;
  customerId: string;
  keyId: string;
  tokenHash: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  label?: string;
}

interface StoreShape {
  keys: StoredUserApiKey[];
}

export class UserApiKeyStore {
  constructor(
    private readonly config: AuthConfig,
    private readonly database?: Database
  ) {}

  async createKey(input: { customerId?: string; keyId?: string; label?: string } = {}) {
    const customerId = normalizeId(input.customerId) || `customer_${crypto.randomUUID()}`;
    const keyId = normalizeId(input.keyId) || `key_${crypto.randomUUID()}`;
    const token = `oyira_live_${crypto.randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const key: StoredUserApiKey = {
      id: crypto.randomUUID(),
      customerId,
      keyId,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 18),
      status: "active",
      createdAt: now,
      label: input.label?.trim() || undefined
    };

    const store = await this.readStore();
    store.keys.push(key);
    await this.writeStore(store);

    return {
      token,
      key: publicKey(key)
    };
  }

  async authenticate(token: string) {
    const envKey = this.authenticateEnvKey(token);
    if (envKey) {
      return envKey;
    }

    const tokenHash = hashToken(token);
    const store = await this.readStore();
    const key = store.keys.find((entry) => entry.status === "active" && secureEqual(entry.tokenHash, tokenHash));

    if (!key) {
      return null;
    }

    key.lastUsedAt = new Date().toISOString();
    await this.writeStore(store);

    return {
      customerId: key.customerId,
      keyId: key.keyId
    };
  }

  async listKeys(customerId?: string) {
    const store = await this.readStore();
    const storedKeys = customerId ? store.keys.filter((key) => key.customerId === customerId) : store.keys;
    const envKeys = this.config.userApiKeys
      .filter((key) => !customerId || key.customerId === customerId)
      .map((key) => ({
        id: `env:${key.keyId}`,
        customerId: key.customerId,
        keyId: key.keyId,
        tokenPrefix: key.token.slice(0, 18),
        status: "active",
        createdAt: "env",
        source: "env"
      }));

    return [...envKeys, ...storedKeys.map((key) => ({ ...publicKey(key), source: "store" }))];
  }

  async revokeKey(keyId: string) {
    const store = await this.readStore();
    const key = store.keys.find((entry) => entry.keyId === keyId || entry.id === keyId);

    if (!key) {
      return null;
    }

    key.status = "revoked";
    key.revokedAt = new Date().toISOString();
    await this.writeStore(store);

    return publicKey(key);
  }

  private authenticateEnvKey(token: string) {
    const key = this.config.userApiKeys.find((entry) => secureEqual(entry.token, token));

    if (!key) {
      return null;
    }

    return {
      customerId: key.customerId,
      keyId: key.keyId
    };
  }

  private async readStore(): Promise<StoreShape> {
    if (this.database?.enabled) {
      const result = await this.database.query<{ record: StoredUserApiKey }>(
        "select record from oyira_user_api_keys order by created_at asc"
      );
      return { keys: result.rows.map((row) => row.record) };
    }

    try {
      const raw = await readFile(this.config.userApiKeyStorePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return { keys: Array.isArray(parsed.keys) ? parsed.keys : [] };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { keys: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape) {
    if (this.database?.enabled) {
      for (const key of store.keys) {
        await this.database.query(
          `insert into oyira_user_api_keys
             (id, customer_id, key_id, status, token_hash, token_prefix, record, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           on conflict (id) do update set
             customer_id = excluded.customer_id,
             key_id = excluded.key_id,
             status = excluded.status,
             token_hash = excluded.token_hash,
             token_prefix = excluded.token_prefix,
             record = excluded.record,
             updated_at = excluded.updated_at`,
          [
            key.id,
            key.customerId,
            key.keyId,
            key.status,
            key.tokenHash,
            key.tokenPrefix,
            JSON.stringify(key),
            key.createdAt,
            key.revokedAt ?? key.lastUsedAt ?? key.createdAt
          ]
        );
      }
      return;
    }

    await mkdir(path.dirname(this.config.userApiKeyStorePath), { recursive: true });
    await writeFile(this.config.userApiKeyStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

function publicKey(key: StoredUserApiKey) {
  return {
    id: key.id,
    customerId: key.customerId,
    keyId: key.keyId,
    tokenPrefix: key.tokenPrefix,
    status: key.status,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
    label: key.label
  };
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeId(value: string | undefined) {
  return value?.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}
