import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainQuoteService } from "./domain-quotes.js";
import { DynadotClient } from "./dynadot.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { OkxPaymentClient } from "./okx.js";

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

const registrationContactSchema = z.object({
  registrantName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(3),
  address: z.string().min(1),
  city: z.string().min(1),
  country: z.string().min(2),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  organization: z.string().optional()
});

export function registerTools(
  server: McpServer,
  dynadot: DynadotClient,
  okx: OkxPaymentClient,
  domainMonitor: DomainMonitorService,
  domainLedger: DomainLedger,
  domainQuotes: DomainQuoteService
) {
  server.tool(
    "quote_domain",
    "Create a domain purchase quote before requesting payment.",
    {
      domainName: z.string().min(3),
      years: z.number().int().min(1).max(10).default(1),
      currency: z.string().length(3).optional(),
      paymentSymbol: z.string().min(1).optional(),
      serviceFeeAmount: z.string().optional()
    },
    async ({ domainName, years, currency, paymentSymbol, serviceFeeAmount }) => {
      return jsonResult(
        await domainQuotes.createQuote({
          domainName,
          years,
          currency,
          paymentSymbol,
          serviceFeeAmount
        })
      );
    }
  );

  server.tool(
    "create_payment_from_quote",
    "Create an OKX payment request using a stored domain quote total.",
    {
      quoteId: z.string().min(1),
      recipient: z.string().min(1),
      description: z.string().optional(),
      externalId: z.string().optional()
    },
    async ({ quoteId, recipient, description, externalId }) => {
      return jsonResult(await domainQuotes.createPaymentFromQuote({ quoteId, recipient, description, externalId }));
    }
  );

  server.tool(
    "get_domain_quote",
    "Get a stored domain purchase quote.",
    {
      quoteId: z.string().min(1)
    },
    async ({ quoteId }) => {
      return jsonResult(await domainQuotes.getQuote(quoteId));
    }
  );

  server.tool(
    "list_domain_quotes",
    "List stored domain purchase quotes.",
    {
      domainName: z.string().min(3).optional(),
      status: z.enum(["quoted", "payment_created", "expired"]).optional()
    },
    async ({ domainName, status }) => {
      return jsonResult(await domainQuotes.listQuotes({ domainName, status }));
    }
  );

  server.tool(
    "create_payment",
    "Create an OKX A2A one-time payment request for a domain purchase.",
    {
      amount: z.string().min(1),
      symbol: z.string().min(1),
      recipient: z.string().min(1),
      description: z.string().optional(),
      externalId: z.string().optional(),
      expiresIn: z.number().int().positive().optional(),
      realm: z.string().optional()
    },
    async ({ amount, symbol, recipient, description, externalId, expiresIn, realm }) => {
      return jsonResult(
        await okx.createPayment({
          amount,
          symbol,
          recipient,
          description,
          externalId,
          expiresIn,
          realm
        })
      );
    }
  );

  server.tool(
    "search_domain",
    "Check domain availability through Dynadot.",
    {
      domainName: z.string().min(3),
      showPrice: z.boolean().default(true),
      currency: z.string().length(3).default("USD")
    },
    async ({ domainName, showPrice, currency }) => {
      return jsonResult(await dynadot.searchDomain(domainName, { showPrice, currency }));
    }
  );

  server.tool(
    "search_domain_variants",
    "Search a bare domain name across multiple TLD extensions.",
    {
      name: z.string().min(1),
      tlds: z.array(z.string().min(2)).optional(),
      currency: z.string().length(3).default("USD"),
      showPrice: z.boolean().default(true)
    },
    async ({ name, tlds, currency, showPrice }) => {
      return jsonResult(await domainQuotes.searchVariants({ name, tlds, currency, showPrice }));
    }
  );

  server.tool(
    "get_domain_price",
    "Get Dynadot TLD pricing for a domain extension.",
    {
      tld: z.string().min(2),
      currency: z.string().length(3).default("USD")
    },
    async ({ tld, currency }) => {
      return jsonResult(await dynadot.getTldPrice(tld, currency));
    }
  );

  server.tool(
    "purchase_domain",
    "Register a domain through Dynadot after payment confirmation.",
    {
      domainName: z.string().min(3),
      years: z.number().int().min(1).max(10).default(1),
      currency: z.string().length(3).default("USD"),
      nameservers: z.array(z.string().min(1)).optional(),
      registrationContact: registrationContactSchema.optional(),
      customerId: z.string().min(1).optional(),
      quoteId: z.string().min(1).optional(),
      paymentId: z.string().min(1),
      expectedPaymentAmount: z.string().optional(),
      expectedPaymentCurrency: z.string().length(3).optional()
    },
    async ({
      domainName,
      years,
      currency,
      nameservers,
      registrationContact,
      customerId,
      quoteId,
      paymentId,
      expectedPaymentAmount,
      expectedPaymentCurrency
    }) => {
      if (!quoteId) {
        throw new Error("purchase_domain requires quoteId so the payment can be verified against a Dynadot-backed quote.");
      }

      const quote = await domainQuotes.assertQuoteUsable(quoteId);

      if (quote && quote.domainName !== domainName.trim().toLowerCase()) {
        throw new Error(`Quote ${quote.id} is for ${quote.domainName}, not ${domainName}.`);
      }

      if (quote && quote.years !== years) {
        throw new Error(`Quote ${quote.id} is for ${quote.years} year(s), not ${years}.`);
      }

      if (!quote.payment) {
        throw new Error(`Quote ${quote.id} does not have a payment request. Call create_payment_from_quote first.`);
      }

      if (quote.payment.paymentId && quote.payment.paymentId !== paymentId) {
        throw new Error(`Quote ${quote.id} is linked to payment ${quote.payment.paymentId}, not ${paymentId}.`);
      }

      const payment = await okx.verifyPayment({
        paymentId,
        expectedAmount: expectedPaymentAmount ?? quote?.totalDue,
        expectedCurrency: expectedPaymentCurrency ?? quote?.paymentSymbol
      });

      const registration = await dynadot.registerDomain({
        domainName,
        years,
        currency: quote?.currency ?? currency,
        nameservers,
        registrationContact,
        paymentConfirmationId: paymentId
      });

      const ledgerRecord = await domainLedger.createRecord({
        domainName,
        customerId,
        years,
        currency: quote?.currency ?? currency,
        paymentId,
        registrationContact,
        dynadotRegistration: registration,
        payment
      });

      return jsonResult({ payment, registration, ledgerRecord });
    }
  );

  server.tool(
    "verify_payment",
    "Verify an OKX payment confirmation before attempting a domain purchase.",
    {
      paymentId: z.string().min(1),
      expectedPaymentAmount: z.string().optional(),
      expectedPaymentCurrency: z.string().length(3).optional()
    },
    async ({ paymentId, expectedPaymentAmount, expectedPaymentCurrency }) => {
      return jsonResult(
        await okx.verifyPayment({
          paymentId,
          expectedAmount: expectedPaymentAmount,
          expectedCurrency: expectedPaymentCurrency
        })
      );
    }
  );

  server.tool(
    "get_order_status",
    "Check Dynadot order status.",
    {
      orderId: z.string().min(1)
    },
    async ({ orderId }) => {
      return jsonResult(await dynadot.getOrderStatus(orderId));
    }
  );

  server.tool(
    "set_nameservers",
    "Set nameservers for a registered domain.",
    {
      domainName: z.string().min(3),
      nameservers: z.array(z.string().min(1)).min(1)
    },
    async ({ domainName, nameservers }) => {
      return jsonResult(await dynadot.setNameservers(domainName, nameservers));
    }
  );

  server.tool(
    "push_domain",
    "Push a purchased domain from our Dynadot account to a customer's Dynadot account.",
    {
      domainName: z.string().min(3),
      targetAccount: z.string().min(1).optional(),
      targetEmail: z.string().email().optional(),
      customerId: z.string().min(1).optional(),
      message: z.string().optional(),
      confirmPush: z.literal(true)
    },
    async ({ domainName, targetAccount, targetEmail, customerId, message }) => {
      if (!targetAccount && !targetEmail) {
        throw new Error("Provide targetAccount or targetEmail for the Dynadot push.");
      }

      const dynadotPush = await dynadot.pushDomain({
        domainName,
        targetAccount,
        targetEmail,
        message
      });

      const ledgerRecord = await domainLedger.recordDomainPush({
        domainName,
        customerId,
        targetAccount,
        targetEmail,
        dynadotPush
      });

      return jsonResult({ dynadotPush, ledgerRecord });
    }
  );

  server.tool(
    "list_domain_ledger_records",
    "List domain ownership ledger records created after successful purchases.",
    {
      domainName: z.string().min(3).optional(),
      customerId: z.string().min(1).optional(),
      paymentId: z.string().min(1).optional()
    },
    async ({ domainName, customerId, paymentId }) => {
      return jsonResult(await domainLedger.listRecords({ domainName, customerId, paymentId }));
    }
  );

  server.tool(
    "get_domain_ledger_record",
    "Get the latest ownership ledger record for a domain, optionally scoped to a customer id.",
    {
      domainName: z.string().min(3),
      customerId: z.string().min(1).optional()
    },
    async ({ domainName, customerId }) => {
      return jsonResult(await domainLedger.getRecordByDomain(domainName, customerId));
    }
  );

  server.tool(
    "add_domain_monitor",
    "Add or update a domain availability monitor.",
    {
      domainName: z.string().min(3),
      customerId: z.string().min(1).optional(),
      alertWhenAvailable: z.boolean().default(true)
    },
    async ({ domainName, customerId, alertWhenAvailable }) => {
      return jsonResult(
        await domainMonitor.addMonitor({
          domainName,
          customerId,
          alertWhenAvailable
        })
      );
    }
  );

  server.tool(
    "monitor_domain_for_customer",
    "Monitor a customer-requested domain and report changes through polling.",
    {
      domainName: z.string().min(3),
      customerId: z.string().min(1).optional(),
      alertWhenAvailable: z.boolean().default(true)
    },
    async ({ domainName, customerId, alertWhenAvailable }) => {
      return jsonResult(
        await domainMonitor.monitorDomainForCustomer({
          domainName,
          customerId,
          alertWhenAvailable
        })
      );
    }
  );

  server.tool(
    "list_domain_monitors",
    "List configured domain monitors.",
    {},
    async () => {
      return jsonResult(await domainMonitor.listMonitors());
    }
  );

  server.tool(
    "remove_domain_monitor",
    "Remove a domain monitor.",
    {
      domainName: z.string().min(3),
      customerId: z.string().min(1).optional()
    },
    async ({ domainName, customerId }) => {
      return jsonResult(await domainMonitor.removeMonitor(domainName, customerId));
    }
  );

  server.tool(
    "check_domain_monitor",
    "Run one domain monitor check.",
    {
      domainName: z.string().min(3),
      customerId: z.string().min(1).optional()
    },
    async ({ domainName, customerId }) => {
      return jsonResult(await domainMonitor.checkMonitor(domainName, customerId));
    }
  );

  server.tool(
    "check_all_domain_monitors",
    "Run all domain monitor checks.",
    {},
    async () => {
      return jsonResult(await domainMonitor.checkAll());
    }
  );
}
