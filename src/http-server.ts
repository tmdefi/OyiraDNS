import http from "node:http";
import crypto from "node:crypto";
import { AuditLog } from "./audit-log.js";
import { loadConfig } from "./config.js";
import { DynadotClient, type RegistrationContact } from "./dynadot.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { DomainQuoteService } from "./domain-quotes.js";
import { GeminiClient } from "./gemini.js";
import { OkxPaymentClient } from "./okx.js";
import { OyiraService, type OyiraMessageInput } from "./oyira-service.js";
import { OyiraSessionStore } from "./oyira-sessions.js";

const config = loadConfig();
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot);
const domainLedger = new DomainLedger(config.ledger);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx);
const gemini = new GeminiClient(config.gemini);
const sessions = new OyiraSessionStore(config.sessions);
const auditLog = new AuditLog(config.audit);
const oyira = new OyiraService(dynadot, domainQuotes, domainMonitor, domainLedger, gemini, sessions);

interface AuthPrincipal {
  role: "owner" | "customer";
  customerId?: string;
  keyId?: string;
}

const server = http.createServer(async (request, response) => {
  try {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-api-auth-token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "oyira-http",
        agent: "oyira",
        geminiModel: config.gemini.model,
        dynadotEnv: config.dynadot.env
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      const readiness = readyReport();
      sendJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/agent/manifest" || url.pathname === "/.well-known/oyira-agent.json")) {
      sendJson(response, 200, manifest());
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/message") {
      const principal = assertAuthorized(request);
      const body = withPrincipal(await readJsonBody<OyiraMessageInput>(request), principal);
      const result = await oyira.handleMessage(body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/create-payment") {
      const principal = assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("create-payment", body, principal, async () => {
        assertConfirmed(body);
        const quoteId = readRequiredString(body, "quoteId");
        const recipient = readOptionalString(body, "recipient") ?? config.okx.walletAddress;

        if (!recipient) {
          throw new HttpError(400, "Missing recipient and OKX_WALLET_ADDRESS is not configured.");
        }

        const quote = await domainQuotes.createPaymentFromQuote({
          quoteId,
          recipient,
          description: readOptionalString(body, "description"),
          externalId: readOptionalString(body, "externalId")
        });

        await updateActionSession(body, principal, {
          lastDomainName: quote.domainName,
          lastQuoteId: quote.id,
          lastPaymentId: quote.payment?.paymentId,
          lastToolName: "create_payment_from_quote"
        });

        return {
          agent: "oyira",
          action: "create-payment",
          reply: `Payment request created for ${quote.domainName}. Payment ID: ${quote.payment?.paymentId ?? "pending"}.`,
          quote
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/verify-payment") {
      const principal = assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("verify-payment", body, principal, async () => {
        assertConfirmed(body);
        const payment = await okx.verifyPayment({
          paymentId: readRequiredString(body, "paymentId"),
          expectedAmount: readOptionalString(body, "expectedPaymentAmount"),
          expectedCurrency: readOptionalString(body, "expectedPaymentCurrency")
        });

        await updateActionSession(body, principal, {
          lastPaymentId: payment.id,
          lastToolName: "verify_payment"
        });

        return {
          agent: "oyira",
          action: "verify-payment",
          reply: `Payment ${payment.id} is verified with status ${payment.status}.`,
          payment
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/purchase-domain") {
      const principal = assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("purchase-domain", body, principal, async () => {
        assertConfirmed(body);

        const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
        const years = readNumber(body, "years", 1);
        const quoteId = readRequiredString(body, "quoteId");
        const paymentId = readRequiredString(body, "paymentId");
        const quote = await domainQuotes.assertQuoteUsable(quoteId);

        if (quote.domainName !== domainName) {
          throw new HttpError(400, `Quote ${quote.id} is for ${quote.domainName}, not ${domainName}.`);
        }

        if (quote.years !== years) {
          throw new HttpError(400, `Quote ${quote.id} is for ${quote.years} year(s), not ${years}.`);
        }

        if (!quote.payment) {
          throw new HttpError(400, `Quote ${quote.id} does not have a payment request. Call create-payment first.`);
        }

        if (quote.payment.paymentId && quote.payment.paymentId !== paymentId) {
          throw new HttpError(400, `Quote ${quote.id} is linked to payment ${quote.payment.paymentId}, not ${paymentId}.`);
        }

        const payment = await okx.verifyPayment({
          paymentId,
          expectedAmount: readOptionalString(body, "expectedPaymentAmount") ?? quote.totalDue,
          expectedCurrency: readOptionalString(body, "expectedPaymentCurrency") ?? quote.paymentSymbol
        });
        const registration = await dynadot.registerDomain({
          domainName,
          years,
          currency: quote.currency,
          nameservers: readStringArray(body, "nameservers"),
          registrationContact: readRegistrationContact(body),
          paymentConfirmationId: paymentId
        });
        const ledgerRecord = await domainLedger.createRecord({
          domainName,
          customerId: readCustomerId(body, principal),
          years,
          currency: quote.currency,
          paymentId,
          registrationContact: readRegistrationContact(body),
          dynadotRegistration: registration,
          payment
        });

        await updateActionSession(body, principal, {
          lastDomainName: domainName,
          lastQuoteId: quote.id,
          lastPaymentId: payment.id,
          lastToolName: "purchase_domain"
        });

        return {
          agent: "oyira",
          action: "purchase-domain",
          reply: `${domainName} has been submitted for registration and recorded in the ledger.`,
          payment,
          registration,
          ledgerRecord
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/push-domain") {
      const principal = assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("push-domain", body, principal, async () => {
        assertConfirmed(body);
        const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
        const targetAccount = readOptionalString(body, "targetAccount");
        const targetEmail = readOptionalString(body, "targetEmail");

        if (!targetAccount && !targetEmail) {
          throw new HttpError(400, "Provide targetAccount or targetEmail for the Dynadot push.");
        }

        const dynadotPush = await dynadot.pushDomain({
          domainName,
          targetAccount,
          targetEmail,
          message: readOptionalString(body, "message")
        });
        const ledgerRecord = await domainLedger.recordDomainPush({
          domainName,
          customerId: readCustomerId(body, principal),
          targetAccount,
          targetEmail,
          dynadotPush
        });

        await updateActionSession(body, principal, {
          lastDomainName: domainName,
          lastToolName: "push_domain"
        });

        return {
          agent: "oyira",
          action: "push-domain",
          reply: `${domainName} push has been requested and recorded in the ledger.`,
          dynadotPush,
          ledgerRecord
        };
      });
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(config.port, () => {
  console.log(`Oyira HTTP service listening on http://localhost:${config.port}`);
});

function manifest() {
  return {
    name: "Oyira",
    id: "oyira",
    kind: "agent-service-provider",
    description: "AI domain commerce agent for search, quote, payment preparation, registration gating, monitoring, and domain transfer support.",
    model: {
      provider: "gemini",
      name: config.gemini.model
    },
    endpoints: {
      health: "/health",
      readiness: "/ready",
      manifest: "/agent/manifest",
      message: "/agent/message",
      actions: {
        createPayment: "/agent/actions/create-payment",
        verifyPayment: "/agent/actions/verify-payment",
        purchaseDomain: "/agent/actions/purchase-domain",
        pushDomain: "/agent/actions/push-domain"
      }
    },
    autoExecutableTools: [
      "search_domain",
      "search_domain_variants",
      "quote_domain",
      "monitor_domain_for_customer",
      "get_domain_quote",
      "list_domain_quotes",
      "get_domain_ledger_record"
    ],
    gatedTools: ["create_payment_from_quote", "verify_payment", "purchase_domain", "push_domain", "set_nameservers"],
    gatedActions: [
      {
        endpoint: "/agent/actions/create-payment",
        required: ["confirm", "quoteId"],
        optional: ["sessionId", "recipient", "description", "externalId"]
      },
      {
        endpoint: "/agent/actions/verify-payment",
        required: ["confirm", "paymentId"],
        optional: ["sessionId", "expectedPaymentAmount", "expectedPaymentCurrency"]
      },
      {
        endpoint: "/agent/actions/purchase-domain",
        required: ["confirm", "domainName", "quoteId", "paymentId"],
        optional: ["sessionId", "customerId", "years", "nameservers", "registrationContact"]
      },
      {
        endpoint: "/agent/actions/push-domain",
        required: ["confirm", "domainName", "targetAccount or targetEmail"],
        optional: ["sessionId", "customerId", "message"]
      }
    ],
    auth: {
      schemes: ["Authorization: Bearer <token>", "x-api-auth-token: <token>"],
      userApiKeys: "Set OYIRA_USER_API_KEYS as customerId:token or customerId:token:keyId entries.",
      ownerToken: "API_AUTH_TOKEN remains accepted for owner/admin access."
    },
    safety: [
      "Quote before payment.",
      "Verify payment before registration.",
      "Require explicit confirmation for live purchase, payment, nameserver changes, and domain pushes."
    ]
  };
}

function assertAuthorized(request: http.IncomingMessage): AuthPrincipal {
  const token = readAuthToken(request);

  if (config.auth.ownerToken && token && secureEqual(token, config.auth.ownerToken)) {
    return { role: "owner", keyId: "owner" };
  }

  const matchedKey = config.auth.userApiKeys.find((entry) => token && secureEqual(token, entry.token));

  if (matchedKey) {
    return {
      role: "customer",
      customerId: matchedKey.customerId,
      keyId: matchedKey.keyId
    };
  }

  if (!config.auth.ownerToken && config.auth.userApiKeys.length === 0) {
    return { role: "owner", keyId: "unauthenticated" };
  }

  throw new HttpError(401, "Unauthorized.");
}

function readAuthToken(request: http.IncomingMessage) {
  const authorization = request.headers.authorization ?? "";
  const tokenHeader = request.headers["x-api-auth-token"];
  const headerToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);

  return bearerMatch?.[1]?.trim() || headerToken?.trim();
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function withPrincipal<T extends OyiraMessageInput>(body: T, principal: AuthPrincipal): T {
  if (principal.role !== "customer" || !principal.customerId) {
    return body;
  }

  return {
    ...body,
    sessionId: body.sessionId ?? principal.customerId,
    customer: {
      ...body.customer,
      id: principal.customerId
    }
  };
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    throw new HttpError(400, "Missing JSON body.");
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function assertConfirmed(body: Record<string, unknown>) {
  if (body.confirm !== true) {
    throw new HttpError(400, "This action requires confirm: true.");
  }
}

function readRequiredString(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  throw new HttpError(400, `Missing required field: ${key}.`);
}

function readOptionalString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(body: Record<string, unknown>, key: string, fallback: number) {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringArray(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : undefined;
}

function readRegistrationContact(body: Record<string, unknown>): RegistrationContact | undefined {
  const value = body.registrationContact;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as RegistrationContact;
}

async function updateActionSession(
  body: Record<string, unknown>,
  principal: AuthPrincipal,
  patch: {
    lastDomainName?: string;
    lastQuoteId?: string;
    lastPaymentId?: string;
    lastToolName?: string;
  }
) {
  const sessionId = readOptionalString(body, "sessionId");
  const customerId = readCustomerId(body, principal);

  if (!sessionId && !customerId) {
    return null;
  }

  const session = await sessions.getOrCreateSession({ sessionId, customerId });

  return sessions.updateSession(session.id, {
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    messages: session.messages
  });
}

async function auditedAction<T extends Record<string, unknown>>(
  action: string,
  body: Record<string, unknown>,
  principal: AuthPrincipal,
  handler: () => Promise<T>
) {
  await auditLog.append({
    action,
    status: "attempt",
    request: auditRequest(body, principal)
  });

  try {
    const result = await handler();
    await auditLog.append({
      action,
      status: "success",
      request: auditRequest(body, principal),
      result: auditResult(result)
    });
    return result;
  } catch (error) {
    await auditLog.append({
      action,
      status: "failure",
      request: auditRequest(body, principal),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function auditRequest(body: Record<string, unknown>, principal: AuthPrincipal) {
  return compactRecord({
    authRole: principal.role,
    authCustomerId: principal.customerId,
    authKeyId: principal.keyId,
    sessionId: readOptionalString(body, "sessionId"),
    customerId: readCustomerId(body, principal),
    domainName: readOptionalString(body, "domainName"),
    quoteId: readOptionalString(body, "quoteId"),
    paymentId: readOptionalString(body, "paymentId"),
    targetAccount: readOptionalString(body, "targetAccount"),
    targetEmail: readOptionalString(body, "targetEmail"),
    confirm: body.confirm === true,
    hasRegistrationContact: Boolean(body.registrationContact)
  });
}

function readCustomerId(body: Record<string, unknown>, principal: AuthPrincipal) {
  if (principal.role === "customer") {
    return principal.customerId;
  }

  return readOptionalString(body, "customerId");
}

function auditResult(result: Record<string, unknown>) {
  const quote = objectValue(result.quote);
  const payment = objectValue(result.payment);
  const ledgerRecord = objectValue(result.ledgerRecord);

  return compactRecord({
    action: readOptionalString(result, "action"),
    quoteId: readOptionalString(quote, "id"),
    paymentId: readOptionalString(payment, "id") ?? readOptionalString(payment, "paymentId"),
    paymentStatus: readOptionalString(payment, "status"),
    domainName: readOptionalString(quote, "domainName") ?? readOptionalString(ledgerRecord, "domainName"),
    ledgerRecordId: readOptionalString(ledgerRecord, "id")
  });
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactRecord(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function readyReport() {
  const checks = [
    check("gemini.apiKey", Boolean(config.gemini.apiKey), "Gemini API key is configured."),
    check("gemini.model", Boolean(config.gemini.model), "Gemini model is configured."),
    check("dynadot.apiKey", Boolean(config.dynadot.apiKey), `Dynadot ${config.dynadot.env} API key is configured.`),
    check("dynadot.apiSecret", Boolean(config.dynadot.apiSecret), `Dynadot ${config.dynadot.env} API secret is configured.`),
    check("okx.apiKey", Boolean(config.okx.apiKey), "OKX API key is configured."),
    check("okx.apiSecret", Boolean(config.okx.apiSecret), "OKX API secret is configured."),
    check("okx.apiPassphrase", Boolean(config.okx.apiPassphrase), "OKX API passphrase is configured."),
    check("okx.walletAddress", Boolean(config.okx.walletAddress), "OKX wallet recipient is configured."),
    check("okx.createPath", Boolean(config.okx.createPath), "OKX payment create path is configured."),
    check("okx.statusPath", Boolean(config.okx.statusPath), "OKX payment status path is configured."),
    check("stores.quotes", Boolean(config.quotes.storePath), "Quote store path is configured."),
    check("stores.ledger", Boolean(config.ledger.storePath), "Ledger store path is configured."),
    check("stores.sessions", Boolean(config.sessions.storePath), "Session store path is configured."),
    check("stores.audit", Boolean(config.audit.logPath), "Audit log path is configured.")
  ];
  const warnings = [
    config.auth.ownerToken || config.auth.userApiKeys.length > 0
      ? null
      : "No API auth tokens are set; HTTP action endpoints are unauthenticated.",
    config.dynadot.env === "live" && !config.dynadot.allowLivePurchases
      ? "Dynadot live environment is selected, but live purchases are disabled."
      : null,
    !config.dynadot.allowDomainPushes ? "Domain pushes are disabled." : null
  ].filter((warning): warning is string => Boolean(warning));

  return {
    ready: checks.every((entry) => entry.ok),
    service: "oyira-http",
    agent: "oyira",
    dynadotEnv: config.dynadot.env,
    livePurchasesEnabled: config.dynadot.allowLivePurchases,
    domainPushesEnabled: config.dynadot.allowDomainPushes,
    checks,
    warnings
  };
}

function check(name: string, ok: boolean, message: string) {
  return {
    name,
    ok,
    message: ok ? message : `${message.replace(" is configured.", "")} is missing.`
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
