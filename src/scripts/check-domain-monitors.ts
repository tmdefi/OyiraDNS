import { loadConfig } from "../config.js";
import { Database } from "../database.js";
import { DynadotClient } from "../dynadot.js";
import { DomainMonitorService } from "../domain-monitor.js";

interface CliOptions {
  add?: string;
  monitorForCustomer?: string;
  remove?: string;
  check?: string;
  list?: boolean;
  alertWhenAvailable?: boolean;
  customerId?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    alertWhenAvailable: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    switch (token) {
      case "--add":
        options.add = next;
        index += 1;
        break;
      case "--monitor-for-customer":
        options.monitorForCustomer = next;
        index += 1;
        break;
      case "--remove":
        options.remove = next;
        index += 1;
        break;
      case "--check":
        options.check = next;
        index += 1;
        break;
      case "--list":
        options.list = true;
        break;
      case "--no-alert-when-available":
        options.alertWhenAvailable = false;
        break;
      case "--customer-id":
        options.customerId = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

const config = loadConfig();
const options = parseArgs(process.argv.slice(2));
const database = new Database(config.database);
const dynadot = new DynadotClient(config.dynadot);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot, database);

let result: unknown;

if (options.monitorForCustomer) {
  result = await domainMonitor.monitorDomainForCustomer({
    domainName: options.monitorForCustomer,
    customerId: options.customerId,
    alertWhenAvailable: options.alertWhenAvailable
  });
} else if (options.add) {
  result = await domainMonitor.addMonitor({
    domainName: options.add,
    alertWhenAvailable: options.alertWhenAvailable,
    customerId: options.customerId
  });
} else if (options.remove) {
  result = await domainMonitor.removeMonitor(options.remove, options.customerId);
} else if (options.check) {
  result = await domainMonitor.checkMonitor(options.check, options.customerId);
} else if (options.list) {
  result = await domainMonitor.listMonitors();
} else {
  result = await domainMonitor.checkAll();
}

console.log(JSON.stringify(result, null, 2));
