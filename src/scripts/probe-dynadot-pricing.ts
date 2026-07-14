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

async function tryRequest(label: string, request: () => Promise<unknown>) {
  try {
    return {
      label,
      ok: true,
      response: await request()
    };
  } catch (error) {
    return {
      label,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const config = loadConfig();
const options = parseArgs(process.argv.slice(2));
const domainName = requiredValue("--domain", options.domain).trim().toLowerCase();
const currency = options.currency ?? config.quotes.defaultCurrency;
const dynadot = new DynadotClient(config.dynadot);
const tld = domainName.includes(".") ? domainName.split(".").at(-1) ?? domainName : domainName;
const encodedDomain = encodeURIComponent(domainName);
const encodedTld = encodeURIComponent(tld);

const probes = await Promise.all([
  tryRequest("domain search showPrice=yes", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { showPrice: "yes", currency }
    })
  ),
  tryRequest("domain search show_price=yes", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { show_price: "yes", currency }
    })
  ),
  tryRequest("domain search show_price=1", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { show_price: "1", currency }
    })
  ),
  tryRequest("domain search show_price=true", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { show_price: "true", currency }
    })
  ),
  tryRequest("domain search show_price=true lowercase currency", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { show_price: "true", currency: currency.toLowerCase() }
    })
  ),
  tryRequest("domain search includePrice=true", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedDomain}/search`, {
      query: { includePrice: "true", currency }
    })
  ),
  tryRequest("tld domain_get_tld_price", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/${encodedTld}/domain_get_tld_price`, {
      query: { currency },
      requireSignature: true
    })
  ),
  tryRequest("collection get_tld_price", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/get_tld_price`, {
      query: { currency: currency.toLowerCase(), tlds: tld },
      requireSignature: true
    })
  ),
  tryRequest("collection get_tld_price show_multi_year", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/get_tld_price`, {
      query: { currency: currency.toLowerCase(), tlds: tld, show_multi_year: "true" },
      requireSignature: true
    })
  ),
  tryRequest("collection domain_get_tld_price tld", () =>
    dynadot.request("GET", `/restful/${config.dynadot.apiVersion}/domains/domain_get_tld_price`, {
      query: { tld, currency },
      requireSignature: true
    })
  )
]);

console.log(
  JSON.stringify(
    {
      dynadotEnv: config.dynadot.env,
      allowLivePurchases: config.dynadot.allowLivePurchases,
      domainName,
      currency,
      probes
    },
    null,
    2
  )
);
