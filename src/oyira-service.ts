import {
  type AgentDecision,
  type AgentPlanStep,
  decideDomainAgentNextAction,
  decideDomainAgentNextActionWithGemini
} from "./agent.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { DomainQuoteService } from "./domain-quotes.js";
import { DynadotClient } from "./dynadot.js";
import { GeminiClient } from "./gemini.js";
import { OyiraSessionStore, type OyiraSession, type OyiraSessionMessage } from "./oyira-sessions.js";

export interface OyiraCustomer {
  id?: string;
}

export interface OyiraMessageInput {
  sessionId?: string;
  message: string;
  customer?: OyiraCustomer;
  execute?: boolean;
  useGemini?: boolean;
}

export interface OyiraToolExecution {
  toolName: string;
  executed: boolean;
  requiresConfirmation: boolean;
  reason: string;
  result?: unknown;
  error?: string;
}

export interface OyiraMessageResult {
  agent: "oyira";
  sessionId: string;
  reply: string;
  decision: AgentDecision;
  toolExecution: OyiraToolExecution | null;
  session: Pick<OyiraSession, "id" | "lastDomainName" | "lastQuoteId" | "lastPaymentId" | "updatedAt">;
}

export class OyiraService {
  constructor(
    private readonly dynadot: DynadotClient,
    private readonly domainQuotes: DomainQuoteService,
    private readonly domainMonitor: DomainMonitorService,
    private readonly domainLedger: DomainLedger,
    private readonly gemini: GeminiClient,
    private readonly sessions: OyiraSessionStore
  ) {}

  async handleMessage(input: OyiraMessageInput): Promise<OyiraMessageResult> {
    const message = input.message.trim();

    if (!message) {
      throw new Error("Missing message.");
    }

    const session = await this.sessions.getOrCreateSession({
      sessionId: input.sessionId,
      customerId: customerId(input.customer)
    });
    const decision = await this.decide(withSessionContext(message, session), input.useGemini ?? true);
    const nextStep = decision.nextSteps[0];
    const toolExecution = input.execute === false || !nextStep ? null : await this.executeStep(nextStep, input.customer);
    const reply = formatReply(decision, toolExecution);
    const now = new Date().toISOString();
    const customerMessage: OyiraSessionMessage = { role: "customer", text: message, createdAt: now };
    const oyiraMessage: OyiraSessionMessage = { role: "oyira", text: reply, createdAt: now };
    const messages = [...session.messages, customerMessage, oyiraMessage].slice(-20);
    const updatedSession = await this.sessions.updateSession(session.id, {
      ...sessionPatchFrom(decision, toolExecution),
      messages
    });

    return {
      agent: "oyira",
      sessionId: updatedSession.id,
      reply,
      decision,
      toolExecution,
      session: {
        id: updatedSession.id,
        lastDomainName: updatedSession.lastDomainName,
        lastQuoteId: updatedSession.lastQuoteId,
        lastPaymentId: updatedSession.lastPaymentId,
        updatedAt: updatedSession.updatedAt
      }
    };
  }

  private async decide(message: string, useGemini: boolean) {
    if (!useGemini || !this.gemini.enabled) {
      return decideDomainAgentNextAction(message);
    }

    try {
      return await decideDomainAgentNextActionWithGemini(message, this.gemini);
    } catch (error) {
      const fallback = decideDomainAgentNextAction(message);
      fallback.reply = `${fallback.reply} Gemini reply generation was unavailable, so I used the local planner.`;
      return fallback;
    }
  }

  private async executeStep(step: AgentPlanStep, customer: OyiraCustomer = {}): Promise<OyiraToolExecution> {
    if (!SAFE_AUTO_TOOLS.has(step.toolName)) {
      return {
        toolName: step.toolName,
        executed: false,
        requiresConfirmation: true,
        reason: "This action can affect payment, ownership, or account state and must be confirmed before execution."
      };
    }

    try {
      return {
        toolName: step.toolName,
        executed: true,
        requiresConfirmation: false,
        reason: step.reason,
        result: await this.executeSafeTool(step, customer)
      };
    } catch (error) {
      return {
        toolName: step.toolName,
        executed: false,
        requiresConfirmation: false,
        reason: step.reason,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private executeSafeTool(step: AgentPlanStep, customer: OyiraCustomer) {
    const args = step.args;

    switch (step.toolName) {
      case "search_domain":
        return this.dynadot.searchDomain(readString(args, "domainName"), {
          showPrice: readBoolean(args, "showPrice", true),
          currency: readString(args, "currency", "USD")
        });
      case "search_domain_variants":
        return this.domainQuotes.searchVariants({
          name: readString(args, "name"),
          tlds: readStringArray(args, "tlds"),
          currency: readString(args, "currency", "USD"),
          showPrice: readBoolean(args, "showPrice", true)
        });
      case "quote_domain":
        return this.domainQuotes.createQuote({
          domainName: readString(args, "domainName"),
          years: readNumber(args, "years", 1),
          currency: readOptionalString(args, "currency"),
          paymentSymbol: readOptionalString(args, "paymentSymbol"),
          serviceFeeAmount: readOptionalString(args, "serviceFeeAmount")
        });
      case "monitor_domain_for_customer":
        return this.domainMonitor.monitorDomainForCustomer({
          domainName: readString(args, "domainName"),
          customerId: readOptionalString(args, "customerId") ?? customer.id,
          alertWhenAvailable: readBoolean(args, "alertWhenAvailable", true)
        });
      case "get_domain_quote":
        return this.domainQuotes.getQuote(readString(args, "quoteId"));
      case "list_domain_quotes":
        return this.domainQuotes.listQuotes({
          domainName: readOptionalString(args, "domainName"),
          status: readOptionalString(args, "status") as "quoted" | "payment_created" | "expired" | undefined
        });
      case "get_domain_ledger_record":
        return this.domainLedger.getRecordByDomain(
          readString(args, "domainName"),
          readOptionalString(args, "customerId") ?? customer.id
        );
      default:
        throw new Error(`Unsupported safe tool: ${step.toolName}.`);
    }
  }
}

const SAFE_AUTO_TOOLS = new Set([
  "search_domain",
  "search_domain_variants",
  "quote_domain",
  "monitor_domain_for_customer",
  "get_domain_quote",
  "list_domain_quotes",
  "get_domain_ledger_record"
]);

function readString(args: Record<string, unknown>, key: string, fallback?: string) {
  const value = args[key];

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`Missing required argument: ${key}.`);
}

function readOptionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function readNumber(args: Record<string, unknown>, key: string, fallback: number) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(args: Record<string, unknown>, key: string, fallback: boolean) {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function readRequired(value: string | undefined, key: string) {
  if (!value) {
    throw new Error(`Missing required customer field: ${key}.`);
  }

  return value;
}

function customerId(customer: OyiraCustomer | undefined) {
  return customer?.id;
}

function withSessionContext(message: string, session: OyiraSession) {
  const context = [
    session.lastDomainName ? `lastDomainName=${session.lastDomainName}` : "",
    session.lastQuoteId ? `lastQuoteId=${session.lastQuoteId}` : "",
    session.lastPaymentId ? `lastPaymentId=${session.lastPaymentId}` : ""
  ].filter(Boolean);

  if (context.length === 0) {
    return message;
  }

  return `${message}\n\nSession context: ${context.join(", ")}`;
}

function sessionPatchFrom(decision: AgentDecision, execution: OyiraToolExecution | null) {
  const nextArgs = decision.nextSteps[0]?.args ?? {};
  const result = execution?.result;

  return compactPatch({
    lastDomainName: readKnownString(nextArgs, "domainName") ?? extractString(result, ["domainName"]),
    lastQuoteId: extractString(result, ["id", "quoteId"]),
    lastPaymentId: extractPaymentId(result),
    lastToolName: execution?.toolName ?? decision.nextSteps[0]?.toolName
  });
}

function compactPatch<T extends Record<string, unknown>>(patch: T) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function formatReply(decision: AgentDecision, execution: OyiraToolExecution | null) {
  if (!execution) {
    return decision.reply;
  }

  if (execution.requiresConfirmation) {
    return formatConfirmationRequired(decision, execution);
  }

  if (execution.error) {
    if (execution.toolName === "quote_domain" && execution.error.startsWith("Domain ") && execution.error.endsWith(" is not available.")) {
      const domainName = execution.error.replace(/^Domain /, "").replace(/ is not available\.$/, "");
      return `${domainName} does not look available right now. I can search variants or monitor it for you.`;
    }

    return `I tried to run ${execution.toolName}, but it failed: ${execution.error}`;
  }

  switch (execution.toolName) {
    case "search_domain":
      return formatSearchResult(execution.result, decision);
    case "search_domain_variants":
      return formatVariantResult(execution.result);
    case "quote_domain":
      return formatQuoteResult(execution.result);
    case "monitor_domain_for_customer":
      return formatMonitorResult(execution.result);
    case "get_domain_quote":
      return formatQuoteResult(execution.result);
    case "list_domain_quotes":
      return formatQuoteList(execution.result);
    case "get_domain_ledger_record":
      return formatLedgerRecord(execution.result);
    default:
      return decision.reply;
  }
}

function formatSearchResult(result: unknown, decision: AgentDecision) {
  const domainName = readKnownString(decision.nextSteps[0]?.args ?? {}, "domainName") ?? "that domain";
  const available = extractAvailability(result);
  const price = extractPrice(result);

  if (available === true) {
    return price
      ? `${domainName} looks available. I found a registration price of ${price}. Want me to create a quote?`
      : `${domainName} looks available. Want me to create a quote?`;
  }

  if (available === false) {
    return `${domainName} does not look available right now. I can search variants or monitor it for you.`;
  }

  return `I checked ${domainName}, but the availability response was unclear. I can try variants or create a monitored watch.`;
}

function formatConfirmationRequired(decision: AgentDecision, execution: OyiraToolExecution) {
  const toolName = execution.toolName;
  const missing = decision.missing.length > 0 ? ` I still need ${decision.missing.join(", ")}.` : "";

  switch (toolName) {
    case "create_payment_from_quote": {
      const quoteId = readKnownString(decision.nextSteps[0]?.args ?? {}, "quoteId");
      return `I can create the payment request${quoteId ? ` for quote ${quoteId}` : ""}, but I need explicit confirmation first.${missing}`;
    }
    case "verify_payment": {
      const paymentId = readKnownString(decision.nextSteps[0]?.args ?? {}, "paymentId");
      return `I can verify the payment${paymentId ? ` ${paymentId}` : ""}, but I need explicit confirmation first.${missing}`;
    }
    case "purchase_domain": {
      const domainName = readKnownString(decision.nextSteps[0]?.args ?? {}, "domainName");
      return `I can register ${domainName ?? "the domain"} after payment and contact details are verified, but I need explicit confirmation first.${missing}`;
    }
    case "push_domain": {
      const domainName = readKnownString(decision.nextSteps[0]?.args ?? {}, "domainName");
      return `I can push ${domainName ?? "the domain"} to the target Dynadot account, but I need explicit confirmation first.${missing}`;
    }
    default:
      return `That step needs explicit confirmation before I run it.${missing}`;
  }
}

function formatVariantResult(result: unknown) {
  const results = extractArray(result, "results");
  const failures = results.filter((entry) => extractString(entry, ["error"]));
  const available = results
    .filter((entry) => extractBoolean(entry, "available") === true)
    .slice(0, 5)
    .map((entry) => {
      const domainName = extractString(entry, ["domainName"]) ?? "unknown";
      const price = extractString(entry, ["registrationPrice"]);
      return price ? `${domainName} (${price})` : domainName;
    });

  if (available.length > 0) {
    return `I found available options: ${available.join(", ")}. Pick one and I can quote it.`;
  }

  if (results.length > 0 && failures.length === results.length) {
    return `I could not complete the variant search because the domain provider request failed. Please try again in a moment.`;
  }

  return "I did not find an available option in the searched TLDs. I can try more extensions or monitor a specific domain.";
}

function formatQuoteResult(result: unknown) {
  const quoteId = extractString(result, ["id", "quoteId"]);
  const domainName = extractString(result, ["domainName"]);
  const totalDue = extractString(result, ["totalDue"]);
  const paymentSymbol = extractString(result, ["paymentSymbol"]);
  const expiresAt = extractString(result, ["expiresAt"]);

  if (!quoteId) {
    return "I could not find a quote in that result.";
  }

  return `Quote ready for ${domainName ?? "the domain"}: ${totalDue ?? "amount pending"} ${paymentSymbol ?? ""}. Quote ID: ${quoteId}. It expires at ${expiresAt ?? "the configured expiry time"}.`;
}

function formatMonitorResult(result: unknown) {
  const monitor = extractObject(result, "monitor");
  const domainName = extractString(monitor, ["domainName"]);
  const nextAction = extractString(result, ["nextAction"]);

  return `I set up monitoring for ${domainName ?? "that domain"}. ${nextAction ?? "I will alert when the monitor detects a change."}`;
}

function formatQuoteList(result: unknown) {
  if (!Array.isArray(result) || result.length === 0) {
    return "I do not see any stored quotes yet.";
  }

  const quotes = result.slice(-5).map((quote) => {
    const domainName = extractString(quote, ["domainName"]) ?? "unknown";
    const quoteId = extractString(quote, ["id"]) ?? "unknown";
    const totalDue = extractString(quote, ["totalDue"]) ?? "amount pending";
    const symbol = extractString(quote, ["paymentSymbol"]) ?? "";
    return `${domainName}: ${totalDue} ${symbol} (${quoteId})`;
  });

  return `Recent quotes: ${quotes.join("; ")}`;
}

function formatLedgerRecord(result: unknown) {
  if (!result) {
    return "I do not see a ledger record for that domain yet.";
  }

  const domainName = extractString(result, ["domainName"]) ?? "the domain";
  const paymentId = extractString(result, ["paymentId"]) ?? "unknown payment";
  return `I found a ledger record for ${domainName}. Payment ID: ${paymentId}.`;
}

function extractAvailability(value: unknown): boolean | null {
  const directAvailability = findAvailabilityValue(value);

  if (directAvailability !== null) {
    return directAvailability;
  }

  const values = flatten(value).map((entry) => entry.toLowerCase());

  if (values.some((entry) => ["unavailable", "taken", "not available", "false"].some((hint) => entry === hint || entry.includes(hint)))) {
    return false;
  }

  if (values.some((entry) => ["available", "true", "yes"].some((hint) => entry === hint || entry.includes(hint)))) {
    return true;
  }

  return null;
}

function findAvailabilityValue(value: unknown): boolean | null {
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const entry = queue.shift();

    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (Array.isArray(entry)) {
      queue.push(...entry);
      continue;
    }

    for (const [key, nested] of Object.entries(entry)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");

      if (["available", "availability", "avail"].includes(normalizedKey)) {
        const normalizedValue = String(nested).trim().toLowerCase();

        if (["yes", "true", "available"].includes(normalizedValue)) {
          return true;
        }

        if (["no", "false", "unavailable", "taken", "not available"].includes(normalizedValue)) {
          return false;
        }
      }

      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return null;
}

function extractPaymentId(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const payment = record.payment;

  if (payment && typeof payment === "object" && !Array.isArray(payment)) {
    return extractString(payment, ["paymentId", "id"]);
  }

  return extractString(record, ["paymentId"]);
}

function extractPrice(value: unknown) {
  const keys = new Set(["price", "registrationprice", "registration_price", "registerprice", "registration"]);
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const entry = queue.shift();

    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (Array.isArray(entry)) {
      queue.push(...entry);
      continue;
    }

    for (const [key, nested] of Object.entries(entry)) {
      const normalized = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
      if (keys.has(normalized) && (typeof nested === "string" || typeof nested === "number")) {
        return String(nested);
      }

      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return undefined;
}

function extractString(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const entry = record[key];

    if (typeof entry === "string" || typeof entry === "number") {
      return String(entry);
    }
  }

  return undefined;
}

function readKnownString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractBoolean(value: unknown, key: string) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "boolean"
    ? ((value as Record<string, unknown>)[key] as boolean)
    : undefined;
}

function extractObject(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entry = (value as Record<string, unknown>)[key];
  return entry && typeof entry === "object" ? entry : undefined;
}

function extractArray(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return [];
  }

  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) ? entry : [];
}

function flatten(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flatten(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => flatten(entry));
  }

  return [];
}
