import http from "node:http";
import crypto from "node:crypto";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402HTTPResourceServer, type HTTPAdapter, type HTTPRequestContext } from "@okxweb3/x402-core/http";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import type { PaymentPayload } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { AuditLog } from "./audit-log.js";
import { loadConfig } from "./config.js";
import { Database } from "./database.js";
import { DynadotClient, type DnsRecordInput, type RegistrationContact } from "./dynadot.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { DomainQuoteService, type DomainQuote } from "./domain-quotes.js";
import { GeminiClient } from "./gemini.js";
import { OkxPaymentClient } from "./okx.js";
import { OyiraService, type OyiraMessageInput } from "./oyira-service.js";
import { OyiraSessionStore } from "./oyira-sessions.js";
import { UserApiKeyStore } from "./user-api-keys.js";
import { hashX402PurchaseRequest, X402PurchaseStore } from "./x402-purchases.js";

const config = loadConfig();
const database = new Database(config.database);
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot, database);
const domainLedger = new DomainLedger(config.ledger, database);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx, database);
const gemini = new GeminiClient(config.gemini);
const sessions = new OyiraSessionStore(config.sessions, database);
const auditLog = new AuditLog(config.audit, database);
const userApiKeys = new UserApiKeyStore(config.auth, database);
const x402Purchases = new X402PurchaseStore(config.x402, database);
const oyira = new OyiraService(dynadot, domainQuotes, domainMonitor, domainLedger, gemini, sessions);
let x402PurchaseServer: Promise<x402HTTPResourceServer> | null = null;
let x402TestPaymentServer: Promise<x402HTTPResourceServer> | null = null;

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

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      sendJson(response, 200, {
        ok: true,
        service: "oyira-http",
        agent: "oyira",
        endpoints: {
          health: "/health",
          readiness: "/ready",
          manifest: "/agent/manifest"
        }
      });
      return;
    }

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
      const readiness = await readyReport();
      sendJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/agent/manifest" || url.pathname === "/.well-known/oyira-agent.json")) {
      sendJson(response, 200, manifest());
      return;
    }

    if (request.method === "POST" && url.pathname === "/public/domain-check") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      sendJson(response, 200, await publicDomainCheck(body));
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

    if (request.method === "GET" && url.pathname === "/agent/x402/purchases") {
      assertOwner(await assertAuthorized(request));
      const purchases = await x402Purchases.list({
        idempotencyKey: url.searchParams.get("idempotencyKey") ?? undefined,
        domainName: url.searchParams.get("domainName") ?? undefined,
        customerId: url.searchParams.get("customerId") ?? undefined,
        x402Payer: url.searchParams.get("x402Payer") ?? undefined,
        status: readX402PurchaseStatus(url.searchParams.get("status"))
      });

      sendJson(response, 200, {
        count: purchases.length,
        purchases: purchases.map(publicX402Purchase)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/x402/purchase-readiness") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      const readiness = await x402PurchaseReadiness(body);
      sendJson(response, readiness.ready ? 200 : 409, readiness);
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

    if (request.method === "POST" && url.pathname === "/agent/brand-discovery") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      sendJson(response, 200, await discoverBrandDomains(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/x402/test-payment") {
      assertX402PaymentConfigured();
      const body = await readJsonBody<Record<string, unknown>>(request);
      const context = x402RequestContext(request, url, body);
      const resourceServer = await getX402TestPaymentServer();
      const paymentResult = await resourceServer.processHTTPRequest(context);

      await auditLog.append({
        action: "x402-test-payment",
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
        throw new HttpError(500, "x402 test payment route did not require payment.");
      }

      const verifiedPaymentPayer = x402PaymentPayloadPayer(paymentResult.paymentPayload);
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
        await auditLog.append({
          action: "x402-test-payment",
          status: "failure",
          request: auditRequest(body, {
            role: "customer",
            customerId: readOptionalString(body, "customerId"),
            keyId: readOptionalString(body, "idempotencyKey")
          }),
          result: {
            x402Payer: verifiedPaymentPayer,
            error: settlement.errorMessage ?? settlement.errorReason
          }
        });
        sendInstructions(response, settlement.response);
        return;
      }

      const customerId = x402CustomerIdFromPayers(verifiedPaymentPayer, settlement);
      await auditLog.append({
        action: "x402-test-payment",
        status: "success",
        request: auditRequest(body, {
          role: "customer",
          customerId,
          keyId: readOptionalString(body, "idempotencyKey")
        }),
        result: {
          x402Payer: verifiedPaymentPayer,
          transaction: settlement.transaction,
          amount: settlement.requirements.amount,
          asset: settlement.requirements.asset,
          network: settlement.requirements.network
        }
      });

      sendJson(
        response,
        200,
        {
          agent: "oyira",
          action: "x402-test-payment",
          status: "payment_settled",
          reply: "x402 test payment settled. No domain purchase was attempted.",
          customerId,
          x402Payer: verifiedPaymentPayer,
          payment: {
            provider: "x402",
            network: settlement.requirements.network,
            transaction: settlement.transaction,
            amount: settlement.requirements.amount,
            asset: settlement.requirements.asset
          }
        },
        settlement.headers
      );
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

      const verifiedPaymentPayer = x402PaymentPayloadPayer(paymentResult.paymentPayload);
      const prepared = await prepareX402Purchase(body);

      if (prepared.record.status === "registered") {
        sendJson(response, 200, {
          agent: "oyira",
          action: "x402-domain-purchase",
          status: "already_registered",
          domainName: prepared.record.domainName,
          years: prepared.record.years,
          quoteId: prepared.record.quoteId,
          customerId: prepared.record.customerId,
          x402Payer: prepared.record.x402Payer,
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

      const settledCustomerId = x402CustomerIdFromPayers(verifiedPaymentPayer, settlement);

      await x402Purchases.update(prepared.record.idempotencyKey, {
        status: "payment_settled",
        paymentTransaction: settlement.transaction,
        customerId: settledCustomerId,
        x402Payer: verifiedPaymentPayer
      });

      const quote = await domainQuotes.assertQuoteUsable(prepared.quote.id, prepared.quote);
      const registrationContact = readRequiredRegistrationContact(body);
      let registration: unknown;
      let ledgerRecord: Awaited<ReturnType<DomainLedger["createRecord"]>>;

      try {
        registration = await dynadot.registerDomain({
          domainName: quote.domainName,
          years: quote.years,
          currency: quote.currency,
          nameservers: readStringArray(body, "nameservers"),
          registrationContact,
          paymentConfirmationId: settlement.transaction ?? prepared.record.idempotencyKey
        });
        ledgerRecord = await domainLedger.createRecord({
          domainName: quote.domainName,
          customerId: settledCustomerId,
          x402Payer: verifiedPaymentPayer,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await x402Purchases.update(prepared.record.idempotencyKey, {
          status: "failed",
          error: `Payment settled but registration failed: ${message}`,
          paymentTransaction: settlement.transaction,
          customerId: settledCustomerId,
          x402Payer: verifiedPaymentPayer
        });
        await auditLog.append({
          action: "x402-domain-purchase",
          status: "failure",
          request: auditRequest(body, {
            role: "customer",
            customerId: settledCustomerId,
            keyId: readOptionalString(body, "idempotencyKey")
          }),
          result: {
            domainName: quote.domainName,
            quoteId: quote.id,
            x402Payer: verifiedPaymentPayer,
            paymentId: settlement.transaction,
            error: message
          }
        });
        throw error;
      }

      await x402Purchases.update(prepared.record.idempotencyKey, {
        status: "registered",
        ledgerRecordId: ledgerRecord.id,
        customerId: settledCustomerId,
        x402Payer: verifiedPaymentPayer
      });
      const customerAccess = await userApiKeys.createKey({
        customerId: settledCustomerId,
        keyId: `x402_${quote.domainName}_${Date.now()}`,
        label: `x402 purchase access for ${quote.domainName}`
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
          x402Payer: verifiedPaymentPayer,
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
            transaction: settlement.transaction,
            x402Payer: verifiedPaymentPayer
          },
          x402Payer: verifiedPaymentPayer,
          customerAccess: {
            customerId: customerAccess.key.customerId,
            keyId: customerAccess.key.keyId,
            apiKey: customerAccess.token,
            tokenType: "Bearer",
            usage: "Use this as Authorization: Bearer <apiKey> for future DNS, nameserver, project-link, and domain-management actions on domains owned by this customer.",
            warning: "Store this API key now. Oyira only shows it once. Do not share it with agents you do not trust."
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
      x402Purchases: "/agent/x402/purchases",
      x402PurchaseReadiness: "/agent/x402/purchase-readiness",
      brandDiscovery: "/agent/brand-discovery",
      message: "/agent/message",
      x402TestPayment: "/x402/test-payment",
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
      publicMarketplace: "No owner token or customer API key is required to buy with x402. A successful first x402 domain purchase returns a one-time customerAccess.apiKey for future owner-scoped domain changes.",
      adminSchemes: ["Authorization: Bearer <owner-token>", "x-api-auth-token: <owner-token>"],
      signup: config.auth.publicSignupEnabled ? "/auth/signup" : "disabled",
      userApiKeys: "Customer API keys authenticate future DNS, nameserver, project-link, and domain-management actions. x402 purchase responses include customerAccess.apiKey; optional env keys can also be set as customerId:token or customerId:token:keyId entries.",
      ownerToken: "API_AUTH_TOKEN remains accepted for owner/admin access.",
      publicSearch: "/public/domain-check",
      publicBrandDiscovery: "/agent/brand-discovery",
      marketplace: "OKX.AI and other public marketplace calls should use structured HTTP clients, send JSON, parse JSON responses directly, and avoid shell pipelines. Use /agent/brand-discovery before quoting brand-only names, or explicitly state any default TLD before calling /x402/domain/purchase. No owner token is required for x402 purchase; after purchase, use the returned customerAccess.apiKey for DNS and project-link changes."
    },
    marketplace: {
      mode: "a2mcp-x402",
      endpoint: "/x402/domain/purchase",
      testEndpoint: "/x402/test-payment",
      requiresCustomerApiKey: false,
      returnsCustomerAccessOnPurchase: true,
      proof: "x402 PAYMENT-SIGNATURE verified and settled through the OKX facilitator before Dynadot registration. Ledger ownership is bound to the verified payment payload payer, and OKX settlement payer must match when present.",
      requiredRequestFields: ["idempotencyKey", "domainName", "years", "registrationContact"],
      registrationContactFields: {
        required: ["registrantName", "email", "phone", "address", "city", "country", "postalCode"],
        optional: ["phoneCountryCode", "state", "organization", "zipCode"],
        note: "Collect the user's own real registration details before payment. zipCode is accepted as an alias for postalCode. Masked placeholders are rejected."
      },
      rail: {
        network: "X Layer",
        chainId: 196,
        asset: "USD₮0"
      }
    },
    domainManagement: {
      auth: "Use Authorization: Bearer <customerAccess.apiKey> from the successful x402 purchase response. Never ask public customers for API_AUTH_TOKEN.",
      ownershipCheck: "Oyira checks the authenticated customer against the domain ledger before changing DNS, nameservers, project links, or pushes.",
      vercel: {
        endpoint: "/agent/actions/link-project",
        method: "POST",
        headers: ["Authorization: Bearer <customerAccess.apiKey>", "Content-Type: application/json"],
        bodyExample: {
          confirm: true,
          domainName: "tmdefi.xyz",
          provider: "vercel"
        }
      },
      dnsRecords: {
        endpoint: "/agent/actions/configure-dns",
        method: "POST",
        headers: ["Authorization: Bearer <customerAccess.apiKey>", "Content-Type: application/json"],
        vercelBodyExample: {
          confirm: true,
          domainName: "tmdefi.xyz",
          records: [
            { type: "a", name: "@", value: "76.76.21.21" },
            { type: "cname", name: "www", value: "cname.vercel-dns.com" }
          ]
        }
      },
      agentInstruction: "If the user asks to point a purchased domain to Vercel, ask for their customerAccess.apiKey if it is not already available, then call link-project with provider=vercel. Do not tell them to log into Dynadot or provide API_AUTH_TOKEN unless they explicitly choose a manual fallback."
    },    publicAgentFlow: [
      "GET /agent/manifest first.",
      "Use POST /public/domain-check for availability and pricing without any token.",
      "Use POST /agent/brand-discovery for brandable name ideas and live TLD checks without any token.",
      "For brand-only requests, use /agent/brand-discovery first or explicitly normalize the brand to a full domain before quoting.",
      "Call endpoints through a structured HTTP client/tool, send JSON, and parse JSON directly; do not pipe endpoint output into an interpreter.",
      "Use /x402/domain/purchase for public marketplace payment proof.",
      "After a successful x402 purchase, store customerAccess.apiKey and use it as Authorization: Bearer <apiKey> for DNS, nameserver, and project-link actions.",
      "Do not ask customers for API_AUTH_TOKEN; that is the owner/admin token. Use customerAccess.apiKey for purchased-domain changes.",
      "Public x402 payments use USD₮0 on X Layer."
    ],
    safety: [
      "Quote before payment.",
      "Verify payment before registration.",
      "For x402 domain purchase, settle x402 payment before Dynadot registration.",
      "Bind x402 marketplace ledger ownership to the verified payment payload payer, not prompt-provided customerId.",
      "Reject x402 settlement if OKX returns a payer that does not match the verified payment payload payer.",
      "Require idempotencyKey for x402 purchase replay protection.",
      "Require explicit confirmation and ledger ownership for DNS record changes.",
      "Require explicit confirmation and ledger ownership for nameserver changes.",
      "Require explicit confirmation and ledger ownership for project preset linking.",
      "Require explicit confirmation for live purchase, payment, nameserver changes, and domain pushes."
    ]
  };
}

async function discoverBrandDomains(body: Record<string, unknown>) {
  const brief = readOptionalString(body, "brief") ?? readOptionalString(body, "description") ?? readOptionalString(body, "prompt");
  if (!brief) {
    throw new HttpError(400, "Provide brief, description, or prompt.");
  }

  const count = Math.min(Math.max(readNumber(body, "count", 8), 1), 20);
  const tlds = readStringArray(body, "tlds")?.slice(0, 8);
  const currency = readOptionalString(body, "currency") ?? config.quotes.defaultCurrency;
  const candidates = await brandNameCandidates(brief, count);
  const uniqueCandidates = uniqueStrings(candidates.map(normalizeBrandBaseName).filter(Boolean)).slice(0, count);
  const checked = await Promise.all(
    uniqueCandidates.map(async (name) => {
      const variants = await domainQuotes.searchVariants({
        name,
        tlds,
        currency,
        showPrice: true
      });
      const available = variants.results.filter((entry) => entry.ok && entry.available === true);

      return {
        name,
        availableCount: available.length,
        bestAvailable: available[0]
          ? {
              domainName: available[0].domainName,
              registrationPrice: available[0].registrationPrice ?? null,
              currency
            }
          : null,
        variants: variants.results.map((entry) => ({
          domainName: entry.domainName,
          available: entry.ok ? entry.available : null,
          registrationPrice: entry.ok ? entry.registrationPrice ?? null : null,
          status: entry.ok ? (entry.available === false ? "unavailable" : "checked") : "check_failed",
          error: entry.ok ? undefined : entry.error
        }))
      };
    })
  );

  checked.sort((left, right) => right.availableCount - left.availableCount || left.name.localeCompare(right.name));

  return {
    agent: "oyira",
    action: "brand-discovery",
    brief,
    currency,
    tlds: tlds ?? config.quotes.defaultTlds,
    count: checked.length,
    suggestions: checked
  };
}

async function publicDomainCheck(body: Record<string, unknown>) {
  const rawDomain = readOptionalString(body, "domainName") ?? readOptionalString(body, "domain") ?? readOptionalString(body, "name");
  if (!rawDomain) {
    throw new HttpError(400, "Provide domainName, domain, or name.");
  }

  const currency = readOptionalString(body, "currency") ?? config.quotes.defaultCurrency;
  const years = Math.min(Math.max(readNumber(body, "years", 1), 1), 10);
  const tlds = readStringArray(body, "tlds")?.slice(0, 8);
  const normalized = rawDomain.trim().toLowerCase();
  const hasTld = /\.[a-z]{2,24}$/.test(normalized);

  if (hasTld) {
    const result = await domainQuotes.inspectDomain({ domainName: normalized, years, currency });
    return {
      agent: "oyira",
      action: "public-domain-check",
      domainName: result.domainName,
      years: result.years,
      currency: result.currency,
      available: result.available,
      registrationPrice: result.registrationPrice,
      pricingWarning: result.pricingWarning,
      tldPrice: result.tldPrice,
      paymentRail: "X Layer",
      paymentAsset: config.quotes.paymentSymbol,
      chainId: 196
    };
  }

  const variants = await domainQuotes.searchVariants({
    name: normalized,
    tlds,
    currency,
    showPrice: true
  });

  return {
    agent: "oyira",
    action: "public-domain-check",
    name: variants.name,
    currency: variants.currency,
    tlds: variants.tlds,
    paymentRail: "X Layer",
    paymentAsset: config.quotes.paymentSymbol,
    chainId: 196,
    suggestions: variants.results.map((entry) => ({
      domainName: entry.domainName,
      available: entry.ok ? entry.available : null,
      registrationPrice: entry.ok ? entry.registrationPrice ?? null : null,
      status: entry.ok ? (entry.available === false ? "unavailable" : "checked") : "check_failed",
      error: entry.ok ? undefined : entry.error
    }))
  };
}

async function brandNameCandidates(brief: string, count: number) {
  if (gemini.enabled) {
    try {
      const result = await gemini.createInteraction(
        `Generate ${count} unique, memorable brand/domain base names for this idea: ${brief}

Rules:
- Return only a JSON array of strings.
- Each string must be 4 to 15 characters.
- Use letters only, no spaces, punctuation, numbers, or TLDs.
- Names should be pronounceable and brandable, not generic keyword phrases.`
      );
      const parsed = parseJsonArray(result.outputText);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Fall through to deterministic local candidates.
    }
  }

  return fallbackBrandNames(brief, count);
}

function parseJsonArray(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function fallbackBrandNames(brief: string, count: number) {
  const words = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !BRAND_STOP_WORDS.has(word))
    .slice(0, 8);
  const roots = words.length > 0 ? words : ["oyira", "nova", "atlas"];
  const suffixes = ["ly", "io", "hq", "go", "nest", "base", "wise", "labs", "loop", "grid"];
  const names: string[] = [];

  for (const root of roots) {
    names.push(root);
    for (const suffix of suffixes) {
      names.push(`${root}${suffix}`);
    }
  }

  for (let index = 0; index < roots.length - 1; index += 1) {
    names.push(`${roots[index]}${roots[index + 1]}`);
  }

  return uniqueStrings(names.map(normalizeBrandBaseName).filter(Boolean)).slice(0, count);
}

function normalizeBrandBaseName(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, "").slice(0, 15);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

const BRAND_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "available",
  "buy",
  "can",
  "check",
  "cost",
  "domain",
  "find",
  "for",
  "how",
  "i",
  "if",
  "is",
  "it",
  "lets",
  "me",
  "monitor",
  "my",
  "please",
  "price",
  "purchase",
  "quote",
  "register",
  "search",
  "show",
  "status",
  "the",
  "to",
  "want",
  "brand",
  "business",
  "company",
  "startup",
  "unique",
  "memorable",
  "name",
  "names",
  "idea"
]);

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
  return `${proto || "https"}://${request.headers.host ?? "asp.oyiradns.xyz"}`;
}

function assertX402PaymentConfigured() {
  if (!config.x402.enabled) {
    throw new HttpError(404, "x402 purchase endpoint is disabled.");
  }

  if (!config.x402.payTo) {
    throw new HttpError(503, "X402_PAY_TO or OKX_WALLET_ADDRESS must be configured before x402 purchases can run.");
  }

  if (!config.okx.apiKey || !config.okx.apiSecret || !config.okx.apiPassphrase) {
    throw new HttpError(503, "OKX facilitator credentials are required before x402 purchases can run.");
  }
}

function assertX402Configured() {
  assertX402PaymentConfigured();
  if (config.dynadot.env === "live" && !config.dynadot.allowLivePurchases) {
    throw new HttpError(503, "Live Dynadot purchases are disabled, so x402 domain purchase payment is not being accepted.");
  }
}

async function getX402TestPaymentServer() {
  if (!x402TestPaymentServer) {
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
      "POST /x402/test-payment": {
        accepts: {
          scheme: "exact",
          network: x402Network,
          payTo: config.x402.payTo,
          price: `$${config.x402.testPaymentAmount}`,
          maxTimeoutSeconds: config.x402.maxTimeoutSeconds
        },
        description: "Settle a small x402 payment through Oyira without registering a domain.",
        mimeType: "application/json",
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            testPayment: {
              amount: config.x402.testPaymentAmount,
              currency: "USD",
              network: config.x402.network,
              payTo: config.x402.payTo
            },
            safeguards: ["This endpoint verifies x402 settlement only.", "No Dynadot purchase or domain registration is attempted."]
          }
        })
      }
    });
    x402TestPaymentServer = httpResourceServer.initialize().then(() => httpResourceServer);
  }

  return x402TestPaymentServer;
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
  const nameservers = readStringArray(body, "nameservers");
  dynadot.registerDomainRequest({
    years,
    currency: config.quotes.defaultCurrency,
    nameservers,
    registrationContact
  });
  const requestHash = hashX402PurchaseRequest({
    customerId,
    domainName,
    years,
    registrationContact,
    nameservers
  });
  const existing = await x402Purchases.getByIdempotencyKey(idempotencyKey);

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, "Idempotency key already belongs to a different x402 purchase request.");
    }

    if (existing.status === "expired") {
      throw new HttpError(410, "x402 purchase challenge expired. Create a fresh quote with a new idempotencyKey before payment.");
    }

    const quote = await domainQuotes.getQuote(existing.quoteId);
    if (!quote) {
      throw new HttpError(409, `Stored quote ${existing.quoteId} was not found for idempotency key ${idempotencyKey}.`);
    }

    if (existing.status === "challenge_created" && isQuoteExpired(quote)) {
      await x402Purchases.update(existing.idempotencyKey, {
        status: "expired",
        error: `Quote ${quote.id} expired at ${quote.expiresAt}.`
      });
      throw new HttpError(410, "x402 purchase challenge expired. Create a fresh quote with a new idempotencyKey before payment.");
    }

    const usableQuote = await domainQuotes.assertQuoteUsable(quote.id, quote);
    if (existing.status !== "registered") {
      await assertDynadotAccountCanCoverQuote(usableQuote);
    }

    return { record: existing, quote: usableQuote };
  }

  const quote = await domainQuotes.createQuote({
    domainName,
    years
  });
  const usableQuote = await domainQuotes.assertQuoteUsable(quote.id, quote);
  await assertDynadotAccountCanCoverQuote(usableQuote);
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

async function x402PurchaseReadiness(body: Record<string, unknown>) {
  const checks: Array<{ name: string; ok: boolean; message: string }> = [];
  let quote: DomainQuote | null = null;

  checks.push({
    name: "x402.config",
    ok: Boolean(config.x402.enabled && config.x402.payTo && config.x402.network),
    message: config.x402.enabled && config.x402.payTo && config.x402.network ? "x402 is configured." : "x402 is not fully configured."
  });
  checks.push({
    name: "livePurchases",
    ok: config.dynadot.allowLivePurchases,
    message: config.dynadot.allowLivePurchases ? "Live Dynadot purchases are enabled." : "Live Dynadot purchases are disabled."
  });
  checks.push({
    name: "x402.storage",
    ok: database.enabled && (await database.ping().catch(() => false)),
    message: database.enabled ? "x402 purchase storage is durable." : "x402 purchase storage is using file fallback."
  });

  try {
    const registrationContact = readRequiredRegistrationContact(body);
    dynadot.registerDomainRequest({
      years: readNumber(body, "years", 1),
      currency: config.quotes.defaultCurrency,
      nameservers: readStringArray(body, "nameservers"),
      registrationContact
    });
    checks.push({ name: "registrationContact", ok: true, message: "Registration contact is valid for Dynadot." });
  } catch (error) {
    checks.push({
      name: "registrationContact",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const quoteId = readOptionalString(body, "quoteId");
    const years = readNumber(body, "years", 1);
    const domainName = readOptionalString(body, "domainName")?.trim().toLowerCase();
    quote = quoteId ? await domainQuotes.getQuote(quoteId) : domainName ? await domainQuotes.createQuote({ domainName, years }) : null;

    if (!quote) {
      checks.push({ name: "quote", ok: false, message: quoteId ? `Quote ${quoteId} was not found.` : "Provide domainName or quoteId." });
    } else if (isQuoteExpired(quote)) {
      checks.push({ name: "quote", ok: false, message: `Quote ${quote.id} expired at ${quote.expiresAt}.` });
    } else {
      checks.push({ name: "quote", ok: true, message: `Quote ${quote.id} is fresh.` });
    }
  } catch (error) {
    checks.push({
      name: "quote",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  if (quote && !isQuoteExpired(quote)) {
    try {
      await assertDynadotAccountCanCoverQuote(quote);
      checks.push({ name: "balance", ok: true, message: "Available balance covers the registration cost." });
    } catch (error) {
      checks.push({
        name: "balance",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    checks.push({ name: "balance", ok: false, message: "Balance check requires a fresh quote." });
  }

  return {
    agent: "oyira",
    action: "x402-purchase-readiness",
    ready: checks.every((entry) => entry.ok),
    livePurchasesEnabled: config.dynadot.allowLivePurchases,
    storageMode: database.enabled ? "postgres" : "file",
    quote: quote
      ? {
          id: quote.id,
          domainName: quote.domainName,
          years: quote.years,
          totalDue: quote.totalDue,
          currency: quote.currency,
          paymentSymbol: quote.paymentSymbol,
          expiresAt: quote.expiresAt,
          expiresInMinutes: Math.max(0, Math.ceil((new Date(quote.expiresAt).getTime() - Date.now()) / 60000)),
          status: isQuoteExpired(quote) ? "expired" : quote.status
        }
      : null,
    checks
  };
}

function isQuoteExpired(quote: DomainQuote) {
  return new Date(quote.expiresAt).getTime() <= Date.now();
}

async function assertDynadotAccountCanCoverQuote(quote: DomainQuote) {
  const accountInfo = await dynadot.getAccountInfo();
  const balance = extractDynadotBalance(accountInfo, quote.currency);
  const registrationCost = Number(quote.dynadotCost);

  if (!Number.isFinite(registrationCost) || registrationCost <= 0) {
    throw new HttpError(503, "Could not verify the registration cost before payment; x402 payment is not being accepted.");
  }

  if (balance === null) {
    throw new HttpError(503, "Could not verify the available balance before payment; x402 payment is not being accepted.");
  }

  if (balance < registrationCost) {
    throw new HttpError(503, "This purchase cannot proceed at this time because OyiraDNS available funds are insufficient.");
  }
}

function extractDynadotBalance(response: unknown, currency: string) {
  const data = objectValue(response);
  const accountInfo = objectValue(objectValue(data.data).account_info ?? data.account_info);
  const balanceList = accountInfo.balance_list;
  const normalizedCurrency = currency.trim().toUpperCase();

  if (Array.isArray(balanceList)) {
    const currencyBalance = balanceList.find((entry) => {
      const balance = objectValue(entry);
      return String(balance.currency ?? "").trim().toUpperCase() === normalizedCurrency;
    });

    const amount = parseLoosePositiveAmount(objectValue(currencyBalance).amount);
    if (amount !== null) {
      return amount;
    }
  }

  return parseLoosePositiveAmount(accountInfo.account_balance);
}

function parseLoosePositiveAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

function x402CustomerIdFromPayers(paymentPayer: string, settlement: { payer?: string }) {
  const settlementPayer = x402NormalizePayer(settlement.payer);

  if (settlementPayer && settlementPayer !== paymentPayer) {
    throw new HttpError(502, "OKX x402 settlement payer did not match the verified payment payload payer.");
  }

  return `x402:${paymentPayer}`;
}

function x402PaymentPayloadPayer(paymentPayload: PaymentPayload) {
  const payload = objectValue(paymentPayload.payload);
  const authorization = objectValue(payload.authorization);
  const permit2Authorization = objectValue(payload.permit2Authorization);
  const payer = x402NormalizePayer(authorization.from) ?? x402NormalizePayer(permit2Authorization.from);

  if (!payer) {
    throw new HttpError(400, "x402 payment payload did not include a payer identity.");
  }

  return payer;
}

function x402NormalizePayer(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
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

function readX402PurchaseStatus(value: string | null) {
  if (!value) {
    return undefined;
  }

  if (value === "challenge_created" || value === "payment_settled" || value === "registered" || value === "failed") {
    return value;
  }

  if (value === "expired") {
    return value;
  }

  throw new HttpError(400, "Unsupported x402 purchase status filter.");
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

  const contact = value as RegistrationContact & { zipCode?: unknown };
  const postalCode = typeof contact.postalCode === "string" && contact.postalCode.trim()
    ? contact.postalCode
    : typeof contact.zipCode === "string" && contact.zipCode.trim()
      ? contact.zipCode
      : undefined;

  return {
    ...contact,
    postalCode
  };
}

function readRequiredRegistrationContact(body: Record<string, unknown>): RegistrationContact {
  const contact = readRegistrationContact(body);

  if (!contact) {
    throw new HttpError(400, "Missing required field: registrationContact.");
  }

  for (const key of ["registrantName", "email", "phone", "address", "city", "country", "postalCode"] as const) {
    if (typeof contact[key] !== "string" || !contact[key]?.trim()) {
      throw new HttpError(400, `Missing required registrationContact field: ${key}.`);
    }
  }

  for (const key of ["registrantName", "email", "phone", "address", "city", "country", "postalCode"] as const) {
    if (contact[key]?.includes("*")) {
      throw new HttpError(400, `registrationContact.${key} must be the user's real registration detail, not a masked placeholder.`);
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
    x402Payer:
      readOptionalString(result, "x402Payer") ??
      readOptionalString(payment, "x402Payer") ??
      readOptionalString(ledgerRecord, "x402Payer"),
    domainName: readOptionalString(quote, "domainName") ?? readOptionalString(ledgerRecord, "domainName"),
    ledgerRecordId: readOptionalString(ledgerRecord, "id")
  });
}

function publicLedgerRecord(record: Awaited<ReturnType<DomainLedger["listRecords"]>>[number]) {
  return compactRecord({
    id: record.id,
    domainName: record.domainName,
    customerId: record.customerId,
    x402Payer: record.x402Payer,
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

function publicX402Purchase(record: Awaited<ReturnType<X402PurchaseStore["list"]>>[number]) {
  return compactRecord({
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    domainName: record.domainName,
    years: record.years,
    quoteId: record.quoteId,
    customerId: record.customerId,
    x402Payer: record.x402Payer,
    status: record.status,
    paymentTransaction: record.paymentTransaction,
    ledgerRecordId: record.ledgerRecordId,
    error: record.error,
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

async function readyReport() {
  const databaseOk = database.enabled ? await database.ping().catch(() => false) : true;
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
    check("x402.testPaymentAmount", Boolean(config.x402.testPaymentAmount), "x402 test payment amount is configured."),
    check("stores.x402Purchases", Boolean(config.x402.purchaseStorePath), "x402 purchase store path is configured."),
    check("stores.quotes", Boolean(config.quotes.storePath), "Quote store path is configured."),
    check("stores.ledger", Boolean(config.ledger.storePath), "Ledger store path is configured."),
    check("stores.sessions", Boolean(config.sessions.storePath), "Session store path is configured."),
    check("stores.audit", Boolean(config.audit.logPath), "Audit log path is configured."),
    database.enabled
      ? {
          name: "database",
          ok: databaseOk,
          message: databaseOk ? "Postgres persistent storage is reachable." : "Postgres persistent storage is configured but unreachable."
        }
      : check("database", true, "File storage fallback is configured."),
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
    returnsCustomerAccessOnPurchase: true,
    storageMode: database.enabled ? "postgres" : "file",
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







