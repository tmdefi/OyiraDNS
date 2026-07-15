import "dotenv/config";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { privateKeyToAccount } from "viem/accounts";

const endpoint = process.env.X402_DOMAIN_PURCHASE_URL ?? "https://asp.oyiradns.xyz/x402/domain/purchase";
const network = process.env.X402_NETWORK ?? "eip155:196";
const privateKey = requiredEnv("X402_PAYER_PRIVATE_KEY");
const domainName = requiredEnv("X402_PURCHASE_DOMAIN").trim().toLowerCase();
const years = numberEnv("X402_PURCHASE_YEARS", 1);
const idempotencyKey = process.env.X402_PURCHASE_IDEMPOTENCY_KEY ?? `x402-purchase-${domainName}-${Date.now()}`;
const nameservers = csvEnv("X402_PURCHASE_NAMESERVERS");

if (!privateKey.startsWith("0x")) {
  throw new Error("X402_PAYER_PRIVATE_KEY must start with 0x.");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const signer = toClientEvmSigner(account);
const coreClient = new x402Client().register(network as `${string}:${string}`, new ExactEvmScheme(signer));
const client = new x402HTTPClient(coreClient);
const body = compactObject({
  idempotencyKey,
  domainName,
  years,
  nameservers,
  registrationContact: compactObject({
    registrantName: requiredEnv("X402_REGISTRANT_NAME"),
    email: requiredEnv("X402_REGISTRANT_EMAIL"),
    phone: requiredEnv("X402_REGISTRANT_PHONE"),
    address: requiredEnv("X402_REGISTRANT_ADDRESS"),
    city: requiredEnv("X402_REGISTRANT_CITY"),
    country: requiredEnv("X402_REGISTRANT_COUNTRY"),
    state: process.env.X402_REGISTRANT_STATE,
    postalCode: process.env.X402_REGISTRANT_POSTAL_CODE,
    organization: process.env.X402_REGISTRANT_ORGANIZATION
  })
});

console.log(`Payer: ${account.address}`);
console.log(`Endpoint: ${endpoint}`);
console.log(`Domain: ${domainName}`);
console.log(`Years: ${years}`);
console.log(`Idempotency key: ${idempotencyKey}`);

const firstResponse = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
const firstText = await firstResponse.text();

if (firstResponse.status !== 402) {
  throw new Error(`Expected HTTP 402 payment challenge, got ${firstResponse.status}: ${firstText}`);
}

console.log("Received x402 payment challenge.");

const paymentRequired = client.getPaymentRequiredResponse((name) => firstResponse.headers.get(name));
const paymentPayload = await client.createPaymentPayload(paymentRequired);
const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);
const paidResponse = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...paymentHeaders
  },
  body: JSON.stringify(body)
});
const responseText = await paidResponse.text();

console.log(`Paid response status: ${paidResponse.status}`);

if (!paidResponse.ok) {
  console.log(
    JSON.stringify(
      {
        responseHeaders: paymentHeadersFrom(paidResponse.headers),
        responseBody: responseText
      },
      null,
      2
    )
  );
  throw new Error(`x402 domain purchase failed with HTTP ${paidResponse.status}.`);
}

const settlement = client.getPaymentSettleResponse((name) => paidResponse.headers.get(name));
console.log(
  JSON.stringify(
    {
      settlement,
      response: JSON.parse(responseText)
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

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function paymentHeadersFrom(headers: Headers) {
  const entries: Record<string, string> = {};

  for (const [key, value] of headers) {
    if (key.toLowerCase().includes("payment") || key.toLowerCase().includes("www")) {
      entries[key] = value;
    }
  }

  return entries;
}
