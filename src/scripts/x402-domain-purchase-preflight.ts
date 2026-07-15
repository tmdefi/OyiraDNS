import "dotenv/config";
import { loadConfig } from "../config.js";
import { DomainQuoteService } from "../domain-quotes.js";
import { DynadotClient, type RegistrationContact } from "../dynadot.js";
import { OkxPaymentClient } from "../okx.js";

const config = loadConfig();
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx);
const domainName = requiredEnv("X402_PURCHASE_DOMAIN").trim().toLowerCase();
const years = numberEnv("X402_PURCHASE_YEARS", 1);
const nameservers = csvEnv("X402_PURCHASE_NAMESERVERS");
const registrationContact: RegistrationContact = {
  registrantName: requiredEnv("X402_REGISTRANT_NAME"),
  email: requiredEnv("X402_REGISTRANT_EMAIL"),
  phone: requiredEnv("X402_REGISTRANT_PHONE"),
  phoneCountryCode: process.env.X402_REGISTRANT_PHONE_CC,
  address: requiredEnv("X402_REGISTRANT_ADDRESS"),
  city: requiredEnv("X402_REGISTRANT_CITY"),
  country: requiredEnv("X402_REGISTRANT_COUNTRY"),
  postalCode: requiredEnv("X402_REGISTRANT_POSTAL_CODE"),
  state: process.env.X402_REGISTRANT_STATE,
  organization: process.env.X402_REGISTRANT_ORGANIZATION
};

const registerBody = dynadot.registerDomainRequest({
  years,
  currency: config.quotes.defaultCurrency,
  nameservers,
  registrationContact
});
const quote = await domainQuotes.createQuote({ domainName, years });
const accountInfo = await dynadot.getAccountInfo();
const balance = extractDynadotBalance(accountInfo, quote.currency);
const dynadotBalanceCoversRegistration = balance !== null && balance >= Number(quote.dynadotCost);

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: true,
      message: "Preflight completed. No x402 payment or Dynadot registration was attempted.",
      domainName,
      years,
      dynadotEnv: config.dynadot.env,
      livePurchasesEnabled: config.dynadot.allowLivePurchases,
      quote: {
        id: quote.id,
        domainName: quote.domainName,
        years: quote.years,
        dynadotCost: quote.dynadotCost,
        currency: quote.currency,
        expiresAt: quote.expiresAt
      },
      dynadotBalanceVerified: balance !== null,
      dynadotBalanceCoversRegistration,
      registerEndpoint: `/restful/${config.dynadot.apiVersion}/domains/${encodeURIComponent(domainName)}/register`,
      registerBodyShape: redactContact(registerBody)
    },
    null,
    2
  )
);

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`${name} must be an integer from 1 to 10.`);
  }

  return value;
}

function csvEnv(name: string) {
  return process.env[name]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function redactContact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactContact(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      ["name", "email", "phone_number", "address1", "city", "zip"].includes(key) ? "[redacted]" : redactContact(entry)
    ])
  );
}
