import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DynadotClient } from "./dynadot.js";
import { DomainLedger } from "./domain-ledger.js";
import { DomainMonitorService } from "./domain-monitor.js";
import { DomainQuoteService } from "./domain-quotes.js";
import { OkxPaymentClient } from "./okx.js";
import { registerTools } from "./tools.js";

const config = loadConfig();

const server = new McpServer({
  name: config.name,
  version: "0.1.0"
});

const dynadot = new DynadotClient(config.dynadot);
const okx = new OkxPaymentClient(config.okx);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot);
const domainLedger = new DomainLedger(config.ledger);
const domainQuotes = new DomainQuoteService(config.quotes, dynadot, okx);

registerTools(server, dynadot, okx, domainMonitor, domainLedger, domainQuotes);

await server.connect(new StdioServerTransport());
