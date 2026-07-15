import "dotenv/config";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { privateKeyToAccount } from "viem/accounts";

const endpoint = process.env.X402_TEST_PAYMENT_URL ?? "https://asp.oyiradns.xyz/x402/test-payment";
const network = process.env.X402_NETWORK ?? "eip155:196";
const privateKey = process.env.X402_PAYER_PRIVATE_KEY;

if (!privateKey) {
  throw new Error("Missing X402_PAYER_PRIVATE_KEY. Use a fresh low-balance test wallet, not a main wallet.");
}

if (!privateKey.startsWith("0x")) {
  throw new Error("X402_PAYER_PRIVATE_KEY must start with 0x.");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const signer = toClientEvmSigner(account);
const coreClient = new x402Client().register(network as `${string}:${string}`, new ExactEvmScheme(signer));
const client = new x402HTTPClient(coreClient);
const body = {
  idempotencyKey: process.env.X402_TEST_IDEMPOTENCY_KEY ?? `x402-test-${Date.now()}`,
  memo: "Oyira x402 live test payment"
};

console.log(`Payer: ${account.address}`);
console.log(`Endpoint: ${endpoint}`);
console.log(`Network: ${network}`);

const firstResponse = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

if (firstResponse.status !== 402) {
  const text = await firstResponse.text();
  throw new Error(`Expected HTTP 402 payment challenge, got ${firstResponse.status}: ${text}`);
}

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
  throw new Error(responseText);
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
