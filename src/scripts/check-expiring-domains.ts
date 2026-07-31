import { DomainLedger } from "../domain-ledger.js";
import { loadConfig } from "../config.js";

async function main() {
  console.log("Checking for expiring domains...");
  
  const config = loadConfig();
  const domainLedger = new DomainLedger(config.ledger);
  
  const daysThreshold = Number(process.env.EXPIRATION_THRESHOLD_DAYS || 30);
  
  const expiringDomains = await domainLedger.getExpiringDomains(daysThreshold);
  
  if (expiringDomains.length === 0) {
    console.log(`No domains expiring within the next ${daysThreshold} days.`);
    return;
  }
  
  console.log(`\nFound ${expiringDomains.length} domain(s) expiring within ${daysThreshold} days:\n`);
  
  for (const record of expiringDomains) {
    console.log(`Domain: ${record.domainName}`);
    console.log(`Owner ID: ${record.customerId ?? "Unknown"}`);
    console.log(`Expiration Date: ${record.expirationDate}`);
    console.log(`Days Remaining: ${record.daysUntilExpiration}`);
    console.log(`Status: ${record.isExpired ? "EXPIRED" : "Expiring Soon"}`);
    console.log("--------------------------------------------------");
  }
}

main().catch((err) => {
  console.error("Error checking expiring domains:", err);
  process.exit(1);
});
