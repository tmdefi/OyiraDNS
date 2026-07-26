import "dotenv/config";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { privateKeyToAccount } from "viem/accounts";

const endpoint = "http://localhost:3000/agent/tools/call";
const network = process.env.X402_NETWORK ?? "eip155:196";
const privateKey = process.env.X402_PAYER_PRIVATE_KEY;

if (!privateKey || !privateKey.startsWith("0x")) {
  throw new Error("X402_PAYER_PRIVATE_KEY must start with 0x.");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const signer = toClientEvmSigner(account);
const coreClient = new x402Client().register(network as `${string}:${string}`, new ExactEvmScheme(signer));
const client = new x402HTTPClient(coreClient);

const body = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "purchase_domain",
    arguments: {
      domainName: "tmdefi.xyz",
      idempotencyKey: `test_purchase_${Date.now()}`,
      years: 1,
      registrationContact: {
        registrantName: "Alice Test",
        email: "alice@example.com",
        phone: "5550100",
        phoneCountryCode: "1",
        address: "123 Test St",
        city: "Testville",
        state: "CA",
        postalCode: "90210",
        country: "US"
      }
    }
  }
};

console.log(`Payer: ${account.address}`);
console.log(`Endpoint: ${endpoint}`);
console.log("Requesting challenge...");

const firstResponse = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
const firstText = await firstResponse.text();

if (firstResponse.status !== 402) {
  throw new Error(`Expected HTTP 402 payment challenge, got ${firstResponse.status}: ${firstText}`);
}

console.log("Received x402 payment challenge. Signing and sending paid request...");

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
  throw new Error(`Paid request failed: ${paidResponse.status} ${responseText}`);
}

console.log("Success! Response:");
console.log(JSON.stringify(JSON.parse(responseText), null, 2));
