import http from "node:http";
import crypto from "node:crypto";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402HTTPResourceServer, type HTTPAdapter, type HTTPRequestContext } from "@okxweb3/x402-core/http";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { AuditLog } from "./audit-log.js";
import { loadConfig } from "./config.js";
import { DynadotClient, type DnsRecordInput, type RegistrationContact } from "./dynadot.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { DomainQuoteService } from "./domain-quotes.js";
import { GeminiClient } from "./gemini.js";
import { OkxPaymentClient } from "./okx.js";
import { OyiraService, type OyiraMessageInput } from "./oyira-service.js";
import { OyiraSessionStore } from "./oyira-sessions.js";
import { UserApiKeyStore } from "./user-api-keys.js";
import { hashX402PurchaseRequest, X402PurchaseStore } from "./x402-purchases.js";

const config = loadConfig();
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot);
const domainLedger = new DomainLedger(config.ledger);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx);
const gemini = new GeminiClient(config.gemini);
const sessions = new OyiraSessionStore(config.sessions);
const auditLog = new AuditLog(config.audit);
const userApiKeys = new UserApiKeyStore(config.auth);
const x402Purchases = new X402PurchaseStore(config.x402);
const oyira = new OyiraService(dynadot, domainQuotes, domainMonitor, domainLedger, gemini, sessions);
let x402PurchaseServer: Promise<x402HTTPResourceServer> | null = null;

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

    if (request.method === "GET" && url.pathname === "/agent/customer/domains") {
      const principal = await assertAuthorized(request);
      const requestedCustomerId = url.searchParams.get("customerId") ?? undefined;
      const customerId = principal.role === "customer" ? principal.customerId : requestedCustomerId;

      if (!customerId) {
        throw new HttpError(400, "Provide customerId.");
      }

      const records = await domainLedger.listRecords({
        customerId,
        domainName: url.searchParams.get("domainName") ?? undefined
      });

      sendJson(response, 200, {
        customerId,
        count: records.length,
        domains: records.map(publicLedgerRecord)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/signup") {
      if (!config.auth.publicSignupEnabled) {
        throw new HttpError(404, "Signup is not enabled.");
      }

      const body = await readJsonBody<Record<string, unknown>>(request);
      const created = await userApiKeys.createKey({
        customerId: readOptionalString(body, "customerId"),
        keyId: readOptionalString(body, "keyId"),
        label: readOptionalString(body, "label")
      });
      sendJson(response, 201, {
        customerId: created.key.customerId,
        keyId: created.key.keyId,
        apiKey: created.token,
        tokenType: "Bearer",
        baseUrl: publicBaseUrl(request),
        warning: "Store this API key now. Oyira only shows it once."
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/api-keys") {
      assertOwner(await assertAuthorized(request));
      sendJson(response, 200, {
        keys: await userApiKeys.listKeys(url.searchParams.get("customerId") ?? undefined)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/api-keys") {
      assertOwner(await assertAuthorized(request));
      const body = await readJsonBody<Record<string, unknown>>(request);
      const created = await userApiKeys.createKey({
        customerId: readOptionalString(body, "customerId"),
        keyId: readOptionalString(body, "keyId"),
        label: readOptionalString(body, "label")
      });
      sendJson(response, 201, {
        customerId: created.key.customerId,
        keyId: created.key.keyId,
        apiKey: created.token,
        tokenType: "Bearer",
        warning: "Store this API key now. Oyira only shows it once."
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/api-keys/revoke") {
      assertOwner(await assertAuthorized(request));
      const body = await readJsonBody<Record<string, unknown>>(request);
      const revoked = await userApiKeys.revokeKey(readRequiredString(body, "keyId"));
      if (!revoked) {
        throw new HttpError(404, "API key not found.");
      }

      sendJson(response, 200, { key: revoked });
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/message") {
      const principal = await assertAuthorized(request);
      const body = withPrincipal(await readJsonBody<OyiraMessageInput>(request), principal);
      const result = await oyira.handleMessage(body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/x402/domain/purchase") {
      assertX402Configured();
      const body = await readJsonBody<Record<string, unknown>>(request);
      const context = x402RequestContext(request, url, body);
      const resourceServer = await getX402PurchaseServer();
      const paymentResult = await resourceServer.processHTTPRequest(context);

      await auditLog.append({
        action: "x402-domain-purchase",
        status: "attempt",
        request: auditRequest(body, {
          role: "customer",
          customerId: readOptionalString(body, "customerId"),
          keyId: readOptionalString(body, "idempotencyKey")
        })
      });

      if (paymentResult.type === "payment-error") {
        sendInstructions(response, paymentResult.response);
        return;
      }

      if (paymentResult.type !== "payment-verified") {
        throw new HttpError(500, "x402 purchase route did not require payment.");
      }

      const prepared = await prepareX402Purchase(body);

      if (prepared.record.status === "registered") {
        sendJson(response, 200, {
          agent: "oyira",
          action: "x402-domain-purchase",
          status: "already_registered",
          domainName: prepared.record.domainName,
          years: prepared.record.years,
          quoteId: prepared.record.quoteId,
          ledgerRecordId: prepared.record.ledgerRecordId
        });
        return;
      }

      const settlement = await resourceServer.processSettlement(
        paymentResult.paymentPayload,
        paymentResult.paymentRequirements,
        paymentResult.declaredExtensions,
        {
          request: context,
          responseBody: Buffer.from("{}"),
          responseHeaders: {}
        }
      );

      if (!settlement.success) {
        await x402Purchases.update(prepared.record.idempotencyKey, {
          status: "failed",
          error: settlement.errorMessage ?? settlement.errorReason
        });
        sendInstructions(response, settlement.response);
        return;
      }

      await x402Purchases.update(prepared.record.idempotencyKey, {
        status: "payment_settled",
        paymentTransaction: settlement.transaction,
        customerId: x402SettledCustomerId(settlement)
      });

      const quote = await domainQuotes.assertQuoteUsable(prepared.quote.id, prepared.quote);
      const registrationContact = readRequiredRegistrationContact(body);
      const settledCustomerId = x402SettledCustomerId(settlement);
      const registration = await dynadot.registerDomain({
        domainName: quote.domainName,
        years: quote.years,
        currency: quote.currency,
        nameservers: readStringArray(body, "nameservers"),
        registrationContact,
        paymentConfirmationId: settlement.transaction ?? prepared.record.idempotencyKey
      });
      const ledgerRecord = await domainLedger.createRecord({
        domainName: quote.domainName,
        customerId: settledCustomerId,
        years: quote.years,
        currency: quote.currency,
        paymentId: settlement.transaction ?? prepared.record.idempotencyKey,
        registrationContact,
        dynadotRegistration: registration,
        payment: {
          provider: "x402",
          network: settlement.requirements.network,
          transaction: settlement.transaction,
          amount: settlement.requirements.amount,
          asset: settlement.requirements.asset
        }
      });

      await x402Purchases.update(prepared.record.idempotencyKey, {
        status: "registered",
        ledgerRecordId: ledgerRecord.id,
        customerId: settledCustomerId
      });
      await auditLog.append({
        action: "x402-domain-purchase",
        status: "success",
        request: auditRequest(body, {
          role: "customer",
          customerId: settledCustomerId,
          keyId: readOptionalString(body, "idempotencyKey")
        }),
        result: {
          domainName: quote.domainName,
          quoteId: quote.id,
          ledgerRecordId: ledgerRecord.id,
          paymentId: settlement.transaction
        }
      });

      sendJson(
        response,
        200,
        {
          agent: "oyira",
          action: "x402-domain-purchase",
          status: "registered",
          reply: `${quote.domainName} has been registered after x402 payment settlement.`,
          quoteId: quote.id,
          domainName: quote.domainName,
          years: quote.years,
          payment: {
            provider: "x402",
            network: settlement.requirements.network,
            transaction: settlement.transaction
          },
          registration,
          ledgerRecord
        },
        settlement.headers
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/create-payment") {
      const principal = await assertAuthorized(request);
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
      const principal = await assertAuthorized(request);
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
      const principal = await assertAuthorized(request);
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
      const principal = await assertAuthorized(request);
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

    if (request.method === "POST" && url.pathname === "/agent/actions/configure-dns") {
      const principal = await assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("configure-dns", body, principal, async () => {
        assertConfirmed(body);
        if (!config.dynadot.allowDnsChanges) {
          throw new HttpError(503, "DNS changes are disabled. Set ALLOW_DNS_CHANGES=true to enable DNS record updates.");
        }

        const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
        const customerId = readCustomerId(body, principal);
        const skipLedgerCheck = principal.role === "owner" && body.skipLedgerCheck === true;

        if (!skipLedgerCheck) {
          const ledgerRecord = await domainLedger.getRecordByDomain(domainName, customerId);

          if (!ledgerRecord) {
            throw new HttpError(404, `No ledger record found for ${domainName}.`);
          }
        }

        const records = readDnsRecords(body);
        const dns = await dynadot.setDns2({
          domainName,
          records,
          ttl: readNumber(body, "ttl", 300),
          append: readBoolean(body, "append", false)
        });

        await updateActionSession(body, principal, {
          lastDomainName: domainName,
          lastToolName: "configure_dns"
        });

        return {
          agent: "oyira",
          action: "configure-dns",
          reply: `${domainName} DNS setup has been submitted to Dynadot.`,
          domainName,
          records,
          dns
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/set-nameservers") {
      const principal = await assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("set-nameservers", body, principal, async () => {
        assertConfirmed(body);
        if (!config.dynadot.allowNameserverChanges) {
          throw new HttpError(503, "Nameserver changes are disabled. Set ALLOW_NAMESERVER_CHANGES=true to enable nameserver updates.");
        }

        const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
        const customerId = readCustomerId(body, principal);
        const skipLedgerCheck = principal.role === "owner" && body.skipLedgerCheck === true;

        if (!skipLedgerCheck) {
          const ledgerRecord = await domainLedger.getRecordByDomain(domainName, customerId);

          if (!ledgerRecord) {
            throw new HttpError(404, `No ledger record found for ${domainName}.`);
          }
        }

        const nameservers = readNameservers(body);
        const dynadotNameservers = await dynadot.setNameservers(domainName, nameservers);

        await updateActionSession(body, principal, {
          lastDomainName: domainName,
          lastToolName: "set_nameservers"
        });

        return {
          agent: "oyira",
          action: "set-nameservers",
          reply: `${domainName} nameserver setup has been submitted to Dynadot.`,
          domainName,
          nameservers,
          dynadotNameservers
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/actions/link-project") {
      const principal = await assertAuthorized(request);
      const body = await readJsonBody<Record<string, unknown>>(request);
      const result = await auditedAction("link-project", body, principal, async () => {
        assertConfirmed(body);
        const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
        const customerId = readCustomerId(body, principal);
        const skipLedgerCheck = principal.role === "owner" && body.skipLedgerCheck === true;

        if (!skipLedgerCheck) {
          const ledgerRecord = await domainLedger.getRecordByDomain(domainName, customerId);

          if (!ledgerRecord) {
            throw new HttpError(404, `No ledger record found for ${domainName}.`);
          }
        }

        const preset = buildProjectPreset(body);

        if (preset.kind === "nameservers") {
          if (!config.dynadot.allowNameserverChanges) {
            throw new HttpError(503, "Nameserver changes are disabled. Set ALLOW_NAMESERVER_CHANGES=true to enable nameserver updates.");
          }

          const dynadotNameservers = await dynadot.setNameservers(domainName, preset.nameservers);

          await updateActionSession(body, principal, {
            lastDomainName: domainName,
            lastToolName: "link_project"
          });

          return {
            agent: "oyira",
            action: "link-project",
            provider: preset.provider,
            mode: "nameservers",
            reply: `${domainName} has been linked to ${preset.provider} using nameservers.`,
            domainName,
            nameservers: preset.nameservers,
            dynadotNameservers
          };
        }

        if (!config.dynadot.allowDnsChanges) {
          throw new HttpError(503, "DNS changes are disabled. Set ALLOW_DNS_CHANGES=true to enable DNS record updates.");
        }

        const dns = await dynadot.setDns2({
          domainName,
          records: preset.records,
          ttl: readNumber(body, "ttl", 300),
          append: readBoolean(body, "append", false)
        });

        await updateActionSession(body, principal, {
          lastDomainName: domainName,
          lastToolName: "link_project"
        });

        return {
          agent: "oyira",
          action: "link-project",
          provider: preset.provider,
          mode: "dns",
          reply: `${domainName} has been linked to ${preset.provider} using DNS records.`,
          domainName,
          records: preset.records,
          dns
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
      signup: "/auth/signup",
      adminApiKeys: "/admin/api-keys",
      customerDomains: "/agent/customer/domains",
      message: "/agent/message",
      x402Purchase: "/x402/domain/purchase",
      actions: {
        createPayment: "/agent/actions/create-payment",
        verifyPayment: "/agent/actions/verify-payment",
        purchaseDomain: "/agent/actions/purchase-domain",
        pushDomain: "/agent/actions/push-domain",
        configureDns: "/agent/actions/configure-dns",
        setNameservers: "/agent/actions/set-nameservers",
        linkProject: "/agent/actions/link-project"
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
    gatedTools: ["create_payment_from_quote", "verify_payment", "purchase_domain", "push_domain", "set_nameservers", "configure_dns", "link_project"],
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
      },
      {
        endpoint: "/agent/actions/configure-dns",
        required: ["confirm", "domainName", "records"],
        optional: ["sessionId", "customerId", "ttl", "append", "skipLedgerCheck"]
      },
      {
        endpoint: "/agent/actions/set-nameservers",
        required: ["confirm", "domainName", "nameservers"],
        optional: ["sessionId", "customerId", "skipLedgerCheck"]
      },
      {
        endpoint: "/agent/actions/link-project",
        required: ["confirm", "domainName", "provider"],
        optional: ["sessionId", "customerId", "target", "frontendTarget", "backendTarget", "nameservers", "ttl", "append", "skipLedgerCheck"]
      }
    ],
    auth: {
      schemes: ["Authorization: Bearer <token>", "x-api-auth-token: <token>"],
      signup: config.auth.publicSignupEnabled ? "/auth/signup" : "disabled",
      userApiKeys: "Customer API keys are for direct/admin-controlled flows. Optional env keys can be set as customerId:token or customerId:token:keyId entries.",
      ownerToken: "API_AUTH_TOKEN remains accepted for owner/admin access.",
      marketplace: "OKX.AI marketplace calls should use /x402/domain/purchase. No customer API key is required; x402 payment verification is the proof rail."
    },
    marketplace: {
      mode: "a2mcp-x402",
      endpoint: "/x402/domain/purchase",
      requiresCustomerApiKey: false,
      proof: "x402 PAYMENT-SIGNATURE verified and settled through the OKX facilitator before Dynadot registration. Ledger ownership is bound to the settled x402 payer.",
      requiredRequestFields: ["idempotencyKey", "domainName", "years", "registrationContact"]
    },
    safety: [
      "Quote before payment.",
      "Verify payment before registration.",
      "For x402 domain purchase, settle x402 payment before Dynadot registration.",
      "Bind x402 marketplace ledger ownership to the settled payer, not prompt-provided customerId.",
      "Require idempotencyKey for x402 purchase replay protection.",
      "Require explicit confirmation and ledger ownership for DNS record changes.",
      "Require explicit confirmation and ledger ownership for nameserver changes.",
      "Require explicit confirmation and ledger ownership for project preset linking.",
      "Require explicit confirmation for live purchase, payment, nameserver changes, and domain pushes."
    ]
  };
}

async function assertAuthorized(request: http.IncomingMessage): Promise<AuthPrincipal> {
  const token = readAuthToken(request);

  if (config.auth.ownerToken && token && secureEqual(token, config.auth.ownerToken)) {
    return { role: "owner", keyId: "owner" };
  }

  const matchedKey = token ? await userApiKeys.authenticate(token) : null;

  if (matchedKey) {
    return {
      role: "customer",
      customerId: matchedKey.customerId,
      keyId: matchedKey.keyId
    };
  }

  throw new HttpError(401, "Unauthorized.");
}

function assertOwner(principal: AuthPrincipal) {
  if (principal.role !== "owner") {
    throw new HttpError(403, "Owner token required.");
  }
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

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { ...headers, "Content-Type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendInstructions(response: http.ServerResponse, instructions: { status: number; headers: Record<string, string>; body?: unknown; isHtml?: boolean }) {
  response.writeHead(instructions.status, {
    ...instructions.headers,
    "Content-Type": instructions.isHtml ? "text/html" : "application/json"
  });
  response.end(
    instructions.isHtml
      ? String(instructions.body ?? "")
      : `${JSON.stringify(instructions.body ?? {}, null, 2)}\n`
  );
}

function publicBaseUrl(request: http.IncomingMessage) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return `${proto || "https"}://${request.headers.host ?? "oyiradns.xyz"}`;
}

function assertX402Configured() {
  if (!config.x402.enabled) {
    throw new HttpError(404, "x402 purchase endpoint is disabled.");
  }

  if (!config.x402.payTo) {
    throw new HttpError(503, "X402_PAY_TO or OKX_WALLET_ADDRESS must be configured before x402 purchases can run.");
  }

  if (!config.okx.apiKey || !config.okx.apiSecret || !config.okx.apiPassphrase) {
    throw new HttpError(503, "OKX facilitator credentials are required before x402 purchases can run.");
  }

  if (config.dynadot.env === "live" && !config.dynadot.allowLivePurchases) {
    throw new HttpError(503, "Live Dynadot purchases are disabled, so x402 domain purchase payment is not being accepted.");
  }
}

async function getX402PurchaseServer() {
  if (!x402PurchaseServer) {
    const facilitator = new OKXFacilitatorClient({
      apiKey: config.okx.apiKey,
      secretKey: config.okx.apiSecret,
      passphrase: config.okx.apiPassphrase,
      baseUrl: config.okx.baseUrl,
      syncSettle: config.x402.syncSettle
    });
    const x402Network = config.x402.network as `${string}:${string}`;
    const resourceServer = new x402ResourceServer(facilitator).register(x402Network, new ExactEvmScheme());
    const httpResourceServer = new x402HTTPResourceServer(resourceServer, {
      "POST /x402/domain/purchase": {
        accepts: {
          scheme: "exact",
          network: x402Network,
          payTo: config.x402.payTo,
          price: async (context) => {
            const prepared = await prepareX402Purchase(asBodyObject(context.adapter.getBody?.()));
            return `$${prepared.quote.totalDue}`;
          },
          maxTimeoutSeconds: config.x402.maxTimeoutSeconds
        },
        description: "Register a domain through Oyira after exact x402 payment settlement.",
        mimeType: "application/json",
        unpaidResponseBody: async (context) => {
          const prepared = await prepareX402Purchase(asBodyObject(context.adapter.getBody?.()));

          return {
            contentType: "application/json",
            body: {
              error: "payment_required",
              quote: {
                id: prepared.quote.id,
                domainName: prepared.quote.domainName,
                years: prepared.quote.years,
                totalDue: prepared.quote.totalDue,
                currency: prepared.quote.currency,
                paymentSymbol: prepared.quote.paymentSymbol,
                expiresAt: prepared.quote.expiresAt
              },
              safeguards: [
                "x402 payment must settle before registration.",
                "idempotencyKey prevents duplicate registrations.",
                "ALLOW_LIVE_PURCHASES must be true for live Dynadot registration."
              ]
            }
          };
        }
      }
    });
    x402PurchaseServer = httpResourceServer.initialize().then(() => httpResourceServer);
  }

  return x402PurchaseServer;
}

async function prepareX402Purchase(body: Record<string, unknown>) {
  const idempotencyKey = readRequiredString(body, "idempotencyKey");
  const domainName = readRequiredString(body, "domainName").trim().toLowerCase();
  const years = readNumber(body, "years", 1);
  const registrationContact = readRequiredRegistrationContact(body);
  const customerId = readOptionalString(body, "customerId");
  const requestHash = hashX402PurchaseRequest({
    customerId,
    domainName,
    years,
    registrationContact,
    nameservers: readStringArray(body, "nameservers")
  });
  const existing = await x402Purchases.getByIdempotencyKey(idempotencyKey);

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, "Idempotency key already belongs to a different x402 purchase request.");
    }

    const quote = await domainQuotes.getQuote(existing.quoteId);
    if (!quote) {
      throw new HttpError(409, `Stored quote ${existing.quoteId} was not found for idempotency key ${idempotencyKey}.`);
    }

    return { record: existing, quote: await domainQuotes.assertQuoteUsable(quote.id, quote) };
  }

  const quote = await domainQuotes.createQuote({
    domainName,
    years
  });
  const usableQuote = await domainQuotes.assertQuoteUsable(quote.id, quote);
  const record = await x402Purchases.create({
    idempotencyKey,
    requestHash,
    domainName: usableQuote.domainName,
    years: usableQuote.years,
    quoteId: usableQuote.id,
    customerId,
    registrationContact
  });

  return { record, quote: usableQuote };
}

function x402RequestContext(
  request: http.IncomingMessage,
  url: URL,
  body: Record<string, unknown>
): HTTPRequestContext {
  const adapter: HTTPAdapter = {
    getHeader: (name) => {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    getMethod: () => request.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => {
      const value = request.headers.accept;
      return Array.isArray(value) ? value.join(",") : value ?? "";
    },
    getUserAgent: () => {
      const value = request.headers["user-agent"];
      return Array.isArray(value) ? value.join(" ") : value ?? "";
    },
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
    getBody: () => body
  };

  return {
    adapter,
    path: url.pathname,
    method: request.method ?? "GET"
  };
}

function asBodyObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Missing JSON body.");
  }

  return value as Record<string, unknown>;
}

function x402SettledCustomerId(settlement: { payer?: string }) {
  if (typeof settlement.payer !== "string" || !settlement.payer.trim()) {
    throw new HttpError(502, "OKX x402 settlement did not include a payer identity.");
  }

  return `x402:${settlement.payer.trim().toLowerCase()}`;
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

function readBoolean(body: Record<string, unknown>, key: string, fallback: boolean) {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : undefined;
}

function readNameservers(body: Record<string, unknown>) {
  const nameservers = readStringArray(body, "nameservers")?.map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""));

  if (!nameservers || nameservers.length < 2) {
    throw new HttpError(400, "Provide at least two nameservers.");
  }

  if (nameservers.length > 13) {
    throw new HttpError(400, "Provide no more than 13 nameservers.");
  }

  const uniqueNameservers = Array.from(new Set(nameservers));

  if (uniqueNameservers.length !== nameservers.length) {
    throw new HttpError(400, "Nameservers must be unique.");
  }

  for (const nameserver of uniqueNameservers) {
    if (!isValidNameserver(nameserver)) {
      throw new HttpError(400, `Invalid nameserver: ${nameserver}.`);
    }
  }

  return uniqueNameservers;
}

function isValidNameserver(nameserver: string) {
  if (nameserver.length > 253 || nameserver.includes("/") || nameserver.includes(":")) {
    return false;
  }

  return nameserver
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function buildProjectPreset(body: Record<string, unknown>):
  | { kind: "dns"; provider: string; records: DnsRecordInput[] }
  | { kind: "nameservers"; provider: string; nameservers: string[] } {
  const provider = readRequiredString(body, "provider").trim().toLowerCase();
  const target = readOptionalString(body, "target");

  switch (provider) {
    case "vercel":
      return {
        kind: "dns",
        provider,
        records: [
          { type: "a", name: "@", value: readOptionalString(body, "rootTarget") ?? "76.76.21.21" },
          { type: "cname", name: readOptionalString(body, "wwwName") ?? "www", value: target ?? "cname.vercel-dns.com" }
        ]
      };
    case "railway":
      return {
        kind: "dns",
        provider,
        records: compactRecords([
          target ? { type: "cname", name: readOptionalString(body, "wwwName") ?? "www", value: target } : undefined,
          readOptionalString(body, "backendTarget")
            ? { type: "cname", name: readOptionalString(body, "backendName") ?? "api", value: readOptionalString(body, "backendTarget") as string }
            : undefined
        ])
      };
    case "netlify":
      return {
        kind: "dns",
        provider,
        records: [
          { type: "cname", name: readOptionalString(body, "wwwName") ?? "www", value: target ?? readRequiredString(body, "target") }
        ]
      };
    case "cloudflare":
      return {
        kind: "nameservers",
        provider,
        nameservers: readNameservers(body)
      };
    case "custom":
    case "custom-frontend-backend": {
      const frontendTarget = readOptionalString(body, "frontendTarget") ?? target;
      const backendTarget = readOptionalString(body, "backendTarget");
      const records = compactRecords([
        frontendTarget ? { type: "cname", name: readOptionalString(body, "frontendName") ?? "www", value: frontendTarget } : undefined,
        backendTarget ? { type: "cname", name: readOptionalString(body, "backendName") ?? "api", value: backendTarget } : undefined
      ]);

      if (records.length === 0) {
        throw new HttpError(400, "Provide target, frontendTarget, or backendTarget for custom project linking.");
      }

      return {
        kind: "dns",
        provider,
        records
      };
    }
    default:
      throw new HttpError(400, `Unsupported project provider: ${provider}.`);
  }
}

function compactRecords(records: Array<DnsRecordInput | undefined>) {
  return records.filter((record): record is DnsRecordInput => Boolean(record));
}

function readDnsRecords(body: Record<string, unknown>): DnsRecordInput[] {
  const value = body.records;

  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "Missing required field: records.");
  }

  if (value.length > 119) {
    throw new HttpError(400, "Too many DNS records. Dynadot supports 20 root records and 99 subdomain records.");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpError(400, `DNS record ${index} must be an object.`);
    }

    const record = entry as Record<string, unknown>;
    const type = readRecordString(record, "type", index).toLowerCase() as DnsRecordInput["type"];
    const name = readOptionalRecordString(record, "name");
    const value = readRecordString(record, "value", index);
    const priority = readOptionalRecordNumber(record, "priority");
    const extra = readOptionalRecordString(record, "extra") ?? readOptionalRecordNumber(record, "extra");

    return {
      type,
      name,
      value,
      priority,
      extra
    };
  });
}

function readRecordString(record: Record<string, unknown>, key: string, index: number) {
  const value = record[key];

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  throw new HttpError(400, `DNS record ${index} is missing ${key}.`);
}

function readOptionalRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalRecordNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRegistrationContact(body: Record<string, unknown>): RegistrationContact | undefined {
  const value = body.registrationContact;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as RegistrationContact;
}

function readRequiredRegistrationContact(body: Record<string, unknown>): RegistrationContact {
  const contact = readRegistrationContact(body);

  if (!contact) {
    throw new HttpError(400, "Missing required field: registrationContact.");
  }

  for (const key of ["registrantName", "email", "phone", "address", "city", "country"] as const) {
    if (typeof contact[key] !== "string" || !contact[key]?.trim()) {
      throw new HttpError(400, `Missing required registrationContact field: ${key}.`);
    }
  }

  return contact;
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
    dnsRecordCount: Array.isArray(body.records) ? body.records.length : undefined,
    nameserverCount: Array.isArray(body.nameservers) ? body.nameservers.length : undefined,
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

function publicLedgerRecord(record: Awaited<ReturnType<DomainLedger["listRecords"]>>[number]) {
  return compactRecord({
    id: record.id,
    domainName: record.domainName,
    customerId: record.customerId,
    years: record.years,
    currency: record.currency,
    paymentId: record.paymentId,
    hasRegistrationContact: Boolean(record.registrationContact),
    hasDomainPush: Boolean(record.domainPush),
    pushedToAccount: record.domainPush?.targetAccount,
    pushedToEmail: record.domainPush?.targetEmail,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
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
    check("x402.payTo", Boolean(config.x402.payTo), "x402 pay-to wallet is configured."),
    check("x402.network", Boolean(config.x402.network), "x402 network is configured."),
    check("stores.x402Purchases", Boolean(config.x402.purchaseStorePath), "x402 purchase store path is configured."),
    check("stores.quotes", Boolean(config.quotes.storePath), "Quote store path is configured."),
    check("stores.ledger", Boolean(config.ledger.storePath), "Ledger store path is configured."),
    check("stores.sessions", Boolean(config.sessions.storePath), "Session store path is configured."),
    check("stores.audit", Boolean(config.audit.logPath), "Audit log path is configured."),
    check("stores.userApiKeys", Boolean(config.auth.userApiKeyStorePath), "User API key store path is configured.")
  ];
  const warnings = [
    config.auth.ownerToken || config.auth.userApiKeys.length > 0 || config.auth.publicSignupEnabled
      ? null
      : "No API auth tokens are set and public signup is disabled; HTTP endpoints cannot be used.",
    config.dynadot.env === "live" && !config.dynadot.allowLivePurchases
      ? "Dynadot live environment is selected, but live purchases are disabled."
      : null,
    !config.dynadot.allowDomainPushes ? "Domain pushes are disabled." : null,
    !config.dynadot.allowDnsChanges ? "DNS changes are disabled." : null,
    !config.dynadot.allowNameserverChanges ? "Nameserver changes are disabled." : null
  ].filter((warning): warning is string => Boolean(warning));

  return {
    ready: checks.every((entry) => entry.ok),
    service: "oyira-http",
    agent: "oyira",
    dynadotEnv: config.dynadot.env,
    marketplaceMode: "a2mcp-x402",
    marketplaceRequiresCustomerApiKey: false,
    livePurchasesEnabled: config.dynadot.allowLivePurchases,
    domainPushesEnabled: config.dynadot.allowDomainPushes,
    dnsChangesEnabled: config.dynadot.allowDnsChanges,
    nameserverChangesEnabled: config.dynadot.allowNameserverChanges,
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
