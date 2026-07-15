import { loadConfig } from "../config.js";
import { Database } from "../database.js";
import { DynadotClient } from "../dynadot.js";
import { DomainMonitorService } from "../domain-monitor.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = loadConfig();
const database = new Database(config.database);
const dynadot = new DynadotClient(config.dynadot);
const domainMonitor = new DomainMonitorService(config.monitoring, dynadot, database);
const intervalMs = Math.max(config.monitoring.intervalSeconds, 10) * 1000;

console.error(`Domain monitor worker started. Interval: ${intervalMs / 1000}s`);

while (true) {
  try {
    const results = await domainMonitor.checkAll();
    const notifyCount = results.filter((result) => result.shouldNotify).length;
    console.error(`Checked ${results.length} monitor(s), ${notifyCount} change(s) need notification at ${new Date().toISOString()}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Monitor worker error: ${message}`);
  }

  await sleep(intervalMs);
}
