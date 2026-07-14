export type AgentIntent =
  | "search"
  | "quote"
  | "payment"
  | "purchase"
  | "monitor"
  | "transfer"
  | "status"
  | "unknown";

export interface AgentPlanStep {
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
}

export interface AgentDecision {
  agentName: string;
  intent: AgentIntent;
  reply: string;
  safetyNotes: string[];
  nextSteps: AgentPlanStep[];
  missing: string[];
  aiProvider?: "gemini";
  aiModel?: string;
}

export interface TextGenerationClient {
  createInteraction(input: string): Promise<{ model: string; outputText: string }>;
}

export const DOMAIN_PURCHASE_AGENT_PROMPT = `
You are Oyira, a careful domain purchasing assistant.

Your job is to help customers search for domains, compare variants, create purchase quotes,
collect payment through OKX, register domains through Dynadot only after payment verification,
monitor unavailable domains, and help transfer purchased domains to customer Dynadot accounts.

Core operating rules:
- Never register or push a domain unless the customer has explicitly asked for that action.
- Always quote before payment, create payment from a stored quote, then verify payment before purchase.
- Treat live Dynadot purchases and domain pushes as high-impact actions.
- If a domain is unavailable, offer monitoring or variant search instead of implying it can be bought.
- Keep answers short, concrete, and customer-facing.
- Do not ask for payment secrets, API keys, seed phrases, private keys, or wallet private material.
- For domain registration, collect only the registration contact details required by the registrar.
- Prefer the existing MCP tools over manual instructions.

Recommended flow:
1. Use search_domain_variants when the user gives a brand/name without a TLD.
2. Use search_domain when the user gives a full domain.
3. Use quote_domain for a chosen available domain.
4. Use create_payment_from_quote after the customer accepts the quote.
5. Use verify_payment before purchase_domain.
6. Use purchase_domain only with quoteId, paymentId, and required registration details.
7. Use monitor_domain_for_customer or add_domain_monitor when a domain is unavailable or the customer asks for alerts.
8. Use push_domain only after the purchased domain is in the ledger and the customer provides a Dynadot target account or email.
`.trim();

const DOMAIN_PATTERN = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,24})\b/i;
const QUOTE_PATTERN = /\bquote_[0-9a-f-]{36}\b/i;
const PAYMENT_PATTERN = /\b(?:pay|payment)[_-]?[a-z0-9-]{6,}\b/i;

export function decideDomainAgentNextAction(message: string): AgentDecision {
  const text = message.trim();
  const normalized = text.toLowerCase();
  const domainName = extractDomainName(text);
  const baseName = extractBaseName(text, domainName);
  const quoteId = matchValue(text, QUOTE_PATTERN);
  const paymentId = matchValue(text, PAYMENT_PATTERN);
  const years = extractYears(text);
  const intent = inferIntent(normalized);
  const safetyNotes = [
    "Quote before payment.",
    "Verify payment before registration.",
    "Require explicit confirmation for live purchase or push."
  ];
  const nextSteps: AgentPlanStep[] = [];
  const missing: string[] = [];

  if (intent === "monitor") {
    if (!domainName) {
      missing.push("domainName");
    }

    if (domainName) {
      nextSteps.push({
        toolName: "monitor_domain_for_customer",
        reason: "Customer asked to watch a domain.",
        args: { domainName, alertWhenAvailable: true }
      });
    }
  } else if (intent === "payment") {
    if (!quoteId) {
      missing.push("quoteId");
    }

    nextSteps.push({
      toolName: "create_payment_from_quote",
      reason: "Payment should be created from a stored quote total.",
      args: compactObject({ quoteId, recipient: "OKX_WALLET_ADDRESS", description: domainName ? `Register ${domainName}` : undefined })
    });
  } else if (intent === "purchase") {
    if (!domainName) {
      missing.push("domainName");
    }

    if (!quoteId) {
      missing.push("quoteId");
    }

    if (!paymentId) {
      missing.push("paymentId");
    }

    missing.push("registrationContact");
    nextSteps.push({
      toolName: "verify_payment",
      reason: "Payment must be verified before attempting registration.",
      args: compactObject({ paymentId })
    });
    nextSteps.push({
      toolName: "purchase_domain",
      reason: "Register only after the payment verification succeeds and contact details are present.",
      args: compactObject({ domainName, years, quoteId, paymentId })
    });
  } else if (intent === "transfer") {
    if (!domainName) {
      missing.push("domainName");
    }

    missing.push("targetAccount or targetEmail");
    nextSteps.push({
      toolName: "get_domain_ledger_record",
      reason: "Confirm the domain is in the ownership ledger before pushing it.",
      args: compactObject({ domainName })
    });
    nextSteps.push({
      toolName: "push_domain",
      reason: "Push requires explicit confirmation plus a Dynadot account or email.",
      args: compactObject({ domainName, confirmPush: true })
    });
  } else if (intent === "status") {
    if (domainName) {
      nextSteps.push({
        toolName: "get_domain_ledger_record",
        reason: "Customer appears to be asking about an owned or purchased domain.",
        args: compactObject({ domainName })
      });
    } else {
      nextSteps.push({
        toolName: "list_domain_quotes",
        reason: "No domain was provided, so list stored quotes for follow-up.",
        args: {}
      });
    }
  } else if (domainName && intent === "quote") {
    nextSteps.push({
      toolName: "quote_domain",
      reason: "Customer asked for a price or quote on a specific domain.",
      args: { domainName, years }
    });
  } else if (domainName) {
    nextSteps.push({
      toolName: "search_domain",
      reason: "Customer provided a full domain name.",
      args: { domainName, showPrice: true, currency: "USD" }
    });
  } else if (baseName) {
    nextSteps.push({
      toolName: "search_domain_variants",
      reason: "Customer provided a brand or base name without a TLD.",
      args: { name: baseName, currency: "USD", showPrice: true }
    });
  } else {
    missing.push("domainName or brand name");
  }

  return {
    agentName: "oyira",
    intent,
    reply: buildReply(intent, nextSteps, missing),
    safetyNotes,
    nextSteps,
    missing: unique(missing)
  };
}

export async function decideDomainAgentNextActionWithGemini(
  message: string,
  gemini: TextGenerationClient
): Promise<AgentDecision> {
  const decision = decideDomainAgentNextAction(message);
  const prompt = buildGeminiDecisionPrompt(message, decision);
  const result = await gemini.createInteraction(prompt);
  const reply = result.outputText.trim();

  return {
    ...decision,
    reply: reply || decision.reply,
    aiProvider: "gemini",
    aiModel: result.model
  };
}

function inferIntent(text: string): AgentIntent {
  const negatesPurchase = /\b(?:do not|don't|dont|no need to|without)\s+(?:buy|purchase|register|secure|grab)\b/.test(text);

  if (/\b(monitor|watch|alert|notify|available again)\b/.test(text)) {
    return "monitor";
  }

  if (/\b(push|transfer|move|send).*\b(domain|dynadot)\b/.test(text)) {
    return "transfer";
  }

  if (/\b(pay|payment|checkout|invoice)\b/.test(text)) {
    return "payment";
  }

  if (!negatesPurchase && /\b(buy|purchase|register|secure it|grab it)\b/.test(text)) {
    return "purchase";
  }

  if (/\b(status|ledger|order|receipt|record)\b/.test(text)) {
    return "status";
  }

  if (/\b(quote|price|cost|how much)\b/.test(text)) {
    return "quote";
  }

  if (/\b(search|find|available|availability|domain)\b/.test(text)) {
    return "search";
  }

  return "unknown";
}

function extractDomainName(text: string) {
  return matchValue(text, DOMAIN_PATTERN)?.toLowerCase();
}

function extractYears(text: string) {
  const match = text.match(/\b([1-9]|10)\s*(?:year|years|yr|yrs)\b/i);
  return match ? Number(match[1]) : 1;
}

function extractBaseName(text: string, domainName?: string) {
  if (domainName) {
    return undefined;
  }

  const candidate = text
    .toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .find((word) => !STOP_WORDS.has(word) && /[a-z]/.test(word));

  return candidate;
}

function matchValue(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match ? match[1] ?? match[0] : undefined;
}

function buildReply(intent: AgentIntent, nextSteps: AgentPlanStep[], missing: string[]) {
  if (missing.length > 0 && nextSteps.length === 0) {
    return `I need ${missing.join(", ")} before I can choose the right domain tool.`;
  }

  if (missing.length > 0) {
    return `I can start with ${nextSteps[0]?.toolName}, but I still need ${unique(missing).join(", ")} before completion.`;
  }

  if (nextSteps.length > 0) {
    return `Next I should call ${nextSteps[0].toolName}.`;
  }

  return `I need a little more detail before acting on this ${intent} request.`;
}

function buildGeminiDecisionPrompt(message: string, decision: AgentDecision) {
  return `
${DOMAIN_PURCHASE_AGENT_PROMPT}

Customer message:
${message}

Local tool plan:
${JSON.stringify(
  {
    intent: decision.intent,
    nextSteps: decision.nextSteps,
    missing: decision.missing,
    safetyNotes: decision.safetyNotes
  },
  null,
  2
)}

Write one concise customer-facing reply. Do not invent tool results. If fields are missing, ask only for the missing fields. If the local tool plan has a next tool, say what you will check or prepare next without exposing internal JSON.
`.trim();
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

const STOP_WORDS = new Set([
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
  "is",
  "it",
  "lets",
  "me",
  "monitor",
  "my",
  "name",
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
  "want"
]);
