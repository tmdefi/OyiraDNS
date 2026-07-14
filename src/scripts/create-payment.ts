import { loadConfig } from "../config.js";
import { OkxPaymentClient } from "../okx.js";

interface CliOptions {
  amount?: string;
  symbol?: string;
  recipient?: string;
  description?: string;
  externalId?: string;
  expiresIn?: number;
  realm?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    switch (token) {
      case "--amount":
        options.amount = next;
        index += 1;
        break;
      case "--symbol":
        options.symbol = next;
        index += 1;
        break;
      case "--recipient":
        options.recipient = next;
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
      case "--expires-in":
        options.expiresIn = next ? Number(next) : undefined;
        index += 1;
        break;
      case "--realm":
        options.realm = next;
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

const config = loadConfig();
const options = parseArgs(process.argv.slice(2));
const client = new OkxPaymentClient(config.okx);

const result = await client.createPayment({
  amount: requiredValue("--amount", options.amount ?? process.env.OKX_TEST_PAYMENT_AMOUNT ?? "0.01"),
  symbol: requiredValue("--symbol", options.symbol ?? config.okx.paymentSymbol),
  recipient: requiredValue("--recipient", options.recipient ?? config.okx.walletAddress),
  description: options.description ?? "Domain purchase test payment",
  externalId: options.externalId ?? `domain-test-${Date.now()}`,
  expiresIn: options.expiresIn ?? 1800,
  realm: options.realm ?? config.okx.paymentRealm ?? undefined
});

const challengeData =
  result.challenge && typeof result.challenge === "object" && "data" in (result.challenge as Record<string, unknown>)
    ? ((result.challenge as Record<string, unknown>).data as Record<string, unknown>)
    : undefined;
const challengeRequest =
  challengeData && typeof challengeData.request === "object"
    ? (challengeData.request as Record<string, unknown>)
    : undefined;

console.log(
  JSON.stringify(
    {
      paymentId: result.paymentId,
      status: result.status,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
      paymentUrl:
        Array.isArray(result.deliveries) && result.deliveries[0] && typeof result.deliveries[0] === "object"
          ? (result.deliveries[0] as Record<string, unknown>).value
          : undefined,
      challengeCurrency: challengeRequest?.currency,
      challengeAmount: challengeRequest?.amount,
      challengeRecipient: challengeRequest?.recipient,
      challengeChainId:
        challengeRequest &&
        typeof challengeRequest.methodDetails === "object" &&
        challengeRequest.methodDetails !== null
          ? (challengeRequest.methodDetails as Record<string, unknown>).chainId
          : undefined
    },
    null,
    2
  )
);
