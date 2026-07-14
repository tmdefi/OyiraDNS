import { loadConfig } from "../config.js";
import { DynadotClient } from "../dynadot.js";

interface CliOptions {
  domain?: string;
  currency?: string;
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
const domainName = requiredValue("--domain", options.domain).trim().toLowerCase();
const currency = options.currency ?? config.quotes.defaultCurrency;
const dynadot = new DynadotClient(config.dynadot);
const tld = domainName.includes(".") ? domainName.split(".").at(-1) ?? domainName : domainName;

let tldPrice: unknown = null;
let tldPriceError: string | null = null;

try {
  tldPrice = await dynadot.getTldPrice(tld, currency);
} catch (error) {
  tldPriceError = error instanceof Error ? error.message : String(error);
}

console.log(
  JSON.stringify(
    {
      dynadotEnv: config.dynadot.env,
      allowLivePurchases: config.dynadot.allowLivePurchases,
      domainName,
      currency,
      searchWithPrice: await dynadot.searchDomain(domainName, { showPrice: true, currency }),
      tld,
      tldPrice,
      tldPriceError
    },
    null,
    2
  )
);
