import { loadConfig } from "../config.js";
import { DomainLedger } from "../domain-ledger.js";
import { DynadotClient } from "../dynadot.js";
import { OkxPaymentClient } from "../okx.js";

interface CliOptions {
  domain?: string;
  years?: number;
  paymentAmount?: string;
  paymentCurrency?: string;
  paymentId?: string;
  description?: string;
  externalId?: string;
  registrantName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  state?: string;
  postalCode?: string;
  organization?: string;
  customerId?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    switch (token) {
      case "--domain":
        options.domain = next;
        index += 1;
        break;
      case "--years":
        options.years = next ? Number(next) : undefined;
        index += 1;
        break;
      case "--payment-amount":
        options.paymentAmount = next;
        index += 1;
        break;
      case "--payment-currency":
        options.paymentCurrency = next;
        index += 1;
        break;
      case "--payment-id":
        options.paymentId = next;
        index += 1;
        break;
      case "--description":
        options.description = next;
        index += 1;
        break;
      case "--external-id":
        options.externalId = next;
        index += 1;
        break;
      case "--registrant-name":
        options.registrantName = next;
        index += 1;
        break;
      case "--email":
        options.email = next;
        index += 1;
        break;
      case "--phone":
        options.phone = next;
        index += 1;
        break;
      case "--address":
        options.address = next;
        index += 1;
        break;
      case "--city":
        options.city = next;
        index += 1;
        break;
      case "--country":
        options.country = next;
        index += 1;
        break;
      case "--state":
        options.state = next;
        index += 1;
        break;
      case "--postal-code":
        options.postalCode = next;
        index += 1;
        break;
      case "--organization":
        options.organization = next;
        index += 1;
        break;
      case "--customer-id":
        options.customerId = next;
        index += 1;
        break;
      case "--wait":
        options.wait = true;
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = next ? Number(next) : undefined;
        index += 1;
        break;
      case "--poll-interval-seconds":
        options.pollIntervalSeconds = next ? Number(next) : undefined;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function requiredValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required value for ${name}.`);
  }

  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = loadConfig();
const options = parseArgs(process.argv.slice(2));
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainLedger = new DomainLedger(config.ledger);

const domainName = requiredValue("--domain", options.domain);
const years = options.years ?? 1;
const paymentCurrency = options.paymentCurrency ?? config.okx.paymentSymbol;
const timeoutSeconds = options.timeoutSeconds ?? 600;
const pollIntervalSeconds = options.pollIntervalSeconds ?? 10;
const registrationContact =
  options.registrantName || options.email || options.phone || options.address || options.city || options.country
    ? {
        registrantName: requiredValue("--registrant-name", options.registrantName),
        email: requiredValue("--email", options.email),
        phone: requiredValue("--phone", options.phone),
        address: requiredValue("--address", options.address),
        city: requiredValue("--city", options.city),
        country: requiredValue("--country", options.country),
        state: options.state,
        postalCode: options.postalCode,
        organization: options.organization
      }
    : undefined;

const availability = await dynadot.searchDomain(domainName, {
  showPrice: true,
  currency: paymentCurrency
});

const tld = domainName.includes(".") ? domainName.split(".").at(-1) ?? domainName : domainName;
let tldPrice: unknown = null;
let pricingWarning: string | null = null;

try {
  tldPrice = await dynadot.getTldPrice(tld, paymentCurrency);
} catch (error) {
  pricingWarning = error instanceof Error ? error.message : String(error);
}

let paymentId = options.paymentId;
let paymentSummary: unknown = null;

if (!paymentId) {
  const paymentAmount = requiredValue("--payment-amount", options.paymentAmount ?? process.env.OKX_TEST_PAYMENT_AMOUNT);
  const createdPayment = await okx.createPayment({
    amount: paymentAmount,
    symbol: paymentCurrency,
    recipient: config.okx.walletAddress,
    description: options.description ?? `Register ${domainName}`,
    externalId: options.externalId ?? `domain-${domainName}-${Date.now()}`
  });

  paymentId = createdPayment.paymentId;
  paymentSummary = createdPayment;
} else {
  paymentSummary = { paymentId };
}

let verifiedPayment: unknown = null;
let registration: unknown = null;
let ledgerRecord: unknown = null;

if (options.wait) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() <= deadline) {
    try {
      verifiedPayment = await okx.verifyPayment({
        paymentId,
        expectedAmount: options.paymentAmount,
        expectedCurrency: paymentCurrency
      });

      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitingForCompletion = message.includes("expected") || message.toLowerCase().includes("status is");

      if (!waitingForCompletion) {
        throw error;
      }

      await sleep(pollIntervalSeconds * 1000);
    }
  }

  if (!verifiedPayment) {
    throw new Error(`Payment ${paymentId} did not reach ${config.okx.requiredStatus} within ${timeoutSeconds} seconds.`);
  }

  registration = await dynadot.registerDomain({
    domainName,
    years,
    currency: paymentCurrency,
    registrationContact,
    paymentConfirmationId: paymentId
  });

  ledgerRecord = await domainLedger.createRecord({
    domainName,
    customerId: options.customerId,
    years,
    currency: paymentCurrency,
    paymentId,
    registrationContact,
    dynadotRegistration: registration,
    payment: verifiedPayment
  });
}

console.log(
  JSON.stringify(
    {
      domainName,
      years,
      availability,
      tldPrice,
      pricingWarning,
      payment: paymentSummary,
      verifiedPayment,
      registration,
      ledgerRecord,
      nextAction: verifiedPayment
        ? "Registration attempted."
        : `Complete payment ${paymentId} and rerun with --payment-id ${paymentId} --wait to continue.`
    },
    null,
    2
  )
);
