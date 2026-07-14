import { loadConfig } from "../config.js";
import { DomainQuoteService } from "../domain-quotes.js";
import { DynadotClient } from "../dynadot.js";
import { OkxPaymentClient } from "../okx.js";

interface CliOptions {
  name?: string;
  tlds?: string[];
  currency?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    switch (token) {
      case "--name":
        options.name = next;
        index += 1;
        break;
      case "--tlds":
        options.tlds = next?.split(",").map((entry) => entry.trim()).filter(Boolean);
        index += 1;
        break;
      case "--currency":
        options.currency = next;
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
const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx);

console.log(
  JSON.stringify(
    await domainQuotes.searchVariants({
      name: requiredValue("--name", options.name),
      tlds: options.tlds,
      currency: options.currency
    }),
    null,
    2
  )
);
