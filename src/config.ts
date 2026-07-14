import "dotenv/config";

export type DynadotEnv = "sandbox" | "live";

export interface DynadotConfig {
  env: DynadotEnv;
  apiVersion: string;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  allowLivePurchases: boolean;
  allowDomainPushes: boolean;
}

export interface OkxPaymentConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  projectId: string;
  walletAddress: string;
  paymentSymbol: string;
  paymentRealm: string;
  createPath: string;
  statusPath: string;
  requiredStatus: string;
  expectedAsset: string;
  expectedNetwork: string;
}

export interface MonitoringConfig {
  storePath: string;
  defaultCurrency: string;
  intervalSeconds: number;
}

export interface LedgerConfig {
  storePath: string;
}

export interface SessionConfig {
  storePath: string;
}

export interface AuditConfig {
  logPath: string;
}

export interface UserApiKey {
  customerId: string;
  keyId: string;
  token: string;
}

export interface AuthConfig {
  ownerToken: string;
  userApiKeys: UserApiKey[];
}

export interface QuoteConfig {
  storePath: string;
  ttlSeconds: number;
  defaultCurrency: string;
  paymentSymbol: string;
  serviceFeeAmount: string;
  defaultTlds: string[];
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface ServiceConfig {
  name: string;
  nodeEnv: string;
  port: number;
  auth: AuthConfig;
  gemini: GeminiConfig;
  dynadot: DynadotConfig;
  okx: OkxPaymentConfig;
  monitoring: MonitoringConfig;
  ledger: LedgerConfig;
  sessions: SessionConfig;
  audit: AuditConfig;
  quotes: QuoteConfig;
}

function readEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function readFirstEnv(names: string[], fallback = ""): string {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return fallback;
}

function parseDynadotEnv(value: string): DynadotEnv {
  return value === "live" ? "live" : "sandbox";
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseUserApiKeys(value: string): UserApiKey[] {
  return parseCsv(value).map((entry) => {
    const [customerId, token, keyId] = entry.split(":").map((part) => part.trim());

    return {
      customerId,
      token,
      keyId: keyId || customerId
    };
  }).filter((entry) => entry.customerId && entry.token);
}

export function loadConfig(): ServiceConfig {
  const dynadotEnv = parseDynadotEnv(readEnv("DYNADOT_ENV", "sandbox"));
  const prefix = dynadotEnv === "live" ? "DYNADOT_LIVE" : "DYNADOT_SANDBOX";
  const defaultDynadotBaseUrl =
    dynadotEnv === "live" ? "https://api.dynadot.com" : "https://api-sandbox.dynadot.com";

  return {
    name: readEnv("SERVICE_NAME", "domain-purchasing-mcp"),
    nodeEnv: readEnv("NODE_ENV", "development"),
    port: Number(readEnv("PORT", "3000")),
    auth: {
      ownerToken: readEnv("API_AUTH_TOKEN"),
      userApiKeys: parseUserApiKeys(readEnv("OYIRA_USER_API_KEYS"))
    },
    gemini: {
      apiKey: readFirstEnv(["GOOGLE_API_KEY", "GEMINI_API_KEY"]),
      model: readEnv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
      baseUrl: readEnv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
    },
    dynadot: {
      env: dynadotEnv,
      apiVersion: readEnv("DYNADOT_API_VERSION", "v2"),
      baseUrl: readEnv(`${prefix}_API_BASE_URL`, defaultDynadotBaseUrl),
      apiKey: readEnv(`${prefix}_API_KEY`),
      apiSecret: readEnv(`${prefix}_API_SECRET`),
      allowLivePurchases: readEnv("ALLOW_LIVE_PURCHASES", "false") === "true",
      allowDomainPushes: readEnv("ALLOW_DOMAIN_PUSHES", "false") === "true"
    },
    okx: {
      baseUrl: readEnv("OKX_BASE_URL", "https://www.okx.com"),
      apiKey: readEnv("OKX_API_KEY"),
      apiSecret: readEnv("OKX_API_SECRET"),
      apiPassphrase: readEnv("OKX_API_PASSPHRASE"),
      projectId: readEnv("OKX_PROJECT_ID"),
      walletAddress: readEnv("OKX_WALLET_ADDRESS"),
      paymentSymbol: readEnv("OKX_PAYMENT_SYMBOL", "OKB"),
      paymentRealm: readEnv("OKX_PAYMENT_REALM"),
      createPath: readEnv("OKX_PAYMENT_CREATE_PATH", "/api/v6/pay/a2a/payment/create"),
      statusPath: readEnv("OKX_PAYMENT_STATUS_PATH", "/api/v6/pay/a2a/p/{paymentId}/status"),
      requiredStatus: readEnv("OKX_REQUIRED_PAYMENT_STATUS", "completed"),
      expectedAsset: readEnv("OKX_SETTLEMENT_ASSET"),
      expectedNetwork: readEnv("OKX_NETWORK")
    },
    monitoring: {
      storePath: readEnv("MONITOR_STORE_PATH", "data/domain-monitors.json"),
      defaultCurrency: readEnv("MONITOR_DEFAULT_CURRENCY", "USD"),
      intervalSeconds: Number(readEnv("MONITOR_INTERVAL_SECONDS", "300"))
    },
    ledger: {
      storePath: readEnv("DOMAIN_LEDGER_STORE_PATH", "data/domain-ledger.json")
    },
    sessions: {
      storePath: readEnv("OYIRA_SESSION_STORE_PATH", "data/oyira-sessions.json")
    },
    audit: {
      logPath: readEnv("OYIRA_AUDIT_LOG_PATH", "data/oyira-audit.jsonl")
    },
    quotes: {
      storePath: readEnv("QUOTE_STORE_PATH", "data/domain-quotes.json"),
      ttlSeconds: Number(readEnv("QUOTE_TTL_SECONDS", "900")),
      defaultCurrency: readEnv("QUOTE_DEFAULT_CURRENCY", "USD"),
      paymentSymbol: readEnv("QUOTE_PAYMENT_SYMBOL", readEnv("OKX_PAYMENT_SYMBOL", "USDC")),
      serviceFeeAmount: readEnv("QUOTE_SERVICE_FEE_AMOUNT", readEnv("SERVICE_FEE_AMOUNT", "0")),
      defaultTlds: parseCsv(readEnv("DOMAIN_SEARCH_DEFAULT_TLDS", "com,xyz,net,org,io,co,app,dev"))
    }
  };
}
