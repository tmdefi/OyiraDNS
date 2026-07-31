# Oyira MCP Service

Oyira is an advanced Model Context Protocol (MCP) server that empowers AI agents to seamlessly search, quote, manage, and natively register Internet domains directly on behalf of users. It integrates with Dynadot for domain lifecycle management and OKX Web3 for crypto-native payment settlements.

A unique feature of this MCP server is its **x402 (Payment Required) Gateway**. Premium actions, such as `purchase_domain`, are gated behind an HTTP 402 challenge, requiring the user to cryptographically prove that they have funded the quoted exact amount on-chain before the action executes.

## Features

- **Domain Availability & Pricing**: Search across dozens of TLDs natively.
- **Dynadot Integration**: Buy domains, set nameservers, push domains to other accounts, and check order statuses.
- **OKX Payment Support**: Securely quote and accept crypto payments using the OKX Pay API.
- **Ownership Ledger**: Maintain a local ledger binding purchased domains to the customer's wallet address.
- **Domain Monitoring**: Schedule and run checks to alert users when highly-coveted domains become available.

---

## 🛠 Available Tools (Parameter Details)

The server exposes the following MCP tools to the agent context:

### `search_domain`
Check domain availability and pricing through Dynadot.
- **`domainName`** *(string, required)*: The domain name to search (e.g. `example.com`). Minimum 3 characters.
- **`showPrice`** *(boolean, optional)*: Include pricing in the response. Default: `true`.
- **`currency`** *(string, optional)*: 3-letter currency code for the price. Default: `"USD"`.

### `search_domain_variants`
Search a bare domain name across multiple TLD extensions.
- **`name`** *(string, required)*: The bare name (without TLD) to search.
- **`tlds`** *(array of strings, optional)*: Specific TLDs to check.
- **`currency`** *(string, optional)*: 3-letter currency code. Default: `"USD"`.
- **`showPrice`** *(boolean, optional)*: Include pricing. Default: `true`.

### `get_domain_price`
Get raw Dynadot TLD pricing for a specific domain extension.
- **`tld`** *(string, required)*: The extension to check (e.g., `com`, `net`).
- **`currency`** *(string, optional)*: 3-letter currency code. Default: `"USD"`.

### `quote_domain`
Create a domain purchase quote (locks in the price) before requesting payment.
- **`domainName`** *(string, required)*: The full domain name to quote.
- **`years`** *(integer, optional)*: Registration years (1-10). Default: `1`.
- **`currency`** *(string, optional)*: 3-letter fiat currency code.
- **`paymentSymbol`** *(string, optional)*: Cryptocurrency ticker for the quote (e.g. `USDT0`).
- **`serviceFeeAmount`** *(string, optional)*: Additional fixed fee markup.

### `purchase_domain` (x402 Protected)
Register a domain through Oyira after exact x402 payment settlement.
- **`idempotencyKey`** *(string, required)*: A unique key (e.g. timestamp or UUID) to prevent duplicate purchases.
- **`domainName`** *(string, required)*: The domain name to purchase.
- **`years`** *(integer, optional)*: Registration years (1-10). Default: `1`.
- **`registrationContact`** *(object, required)*:
  - `registrantName` *(string, required)*
  - `email` *(string, required)*
  - `phone` *(string, required)*
  - `phoneCountryCode` *(string, optional)*
  - `address` *(string, required)*
  - `city` *(string, required)*
  - `country` *(string, required)*
  - `state` *(string, optional)*
  - `postalCode` *(string, required)*
  - `organization` *(string, optional)*
- **`nameservers`** *(array of strings, optional)*: Up to 13 nameservers to set upon registration.

### `quote_renewal`
Create a domain renewal quote (locks in the price) before requesting payment. Requires `Authorization: Bearer <apiKey>`.
- **`domainName`** *(string, optional)*: The full domain name to quote. If omitted, lists your renewable domains.
- **`years`** *(integer, optional)*: Renewal years (1-10). Default: `1`.
- **`currency`** *(string, optional)*: 3-letter fiat currency code.
- **`paymentSymbol`** *(string, optional)*: Cryptocurrency ticker for the quote (e.g. `USDT0`).

### `renew_domain` (x402 Protected)
Renew a domain through Oyira after exact x402 payment settlement. Requires `Authorization: Bearer <apiKey>`.
- **`idempotencyKey`** *(string, required)*: A unique key (e.g. timestamp or UUID) to prevent duplicate renewals.
- **`domainName`** *(string, required)*: The domain name to renew.
- **`years`** *(integer, optional)*: Renewal years (1-10). Default: `1`.

### `get_expiring_domains`
List domains that are expiring within a certain number of days. Requires `Authorization: Bearer <apiKey>`.
- **`daysThreshold`** *(integer, optional)*: Number of days. Default: `30`.

### `set_nameservers`
Set nameservers for a registered domain.
- **`domainName`** *(string, required)*: The domain to update.
- **`nameservers`** *(array of strings, required)*: Array of nameserver hosts (minimum 1).

### `push_domain`
Push a purchased domain from the server's Dynadot account to a customer's personal Dynadot account.
- **`domainName`** *(string, required)*: The domain to push.
- **`targetAccount`** *(string, optional)*: The destination Dynadot username.
- **`targetEmail`** *(string, optional)*: The destination Dynadot email. (Must provide either account or email).
- **`customerId`** *(string, optional)*: The internal wallet/user ID making the request.
- **`message`** *(string, optional)*: An optional message attached to the push.
- **`confirmPush`** *(boolean, required)*: Must be explicitly passed as `true`.

### `add_domain_monitor`
Add or update a scheduled domain availability monitor.
- **`domainName`** *(string, required)*: The domain to monitor.
- **`customerId`** *(string, optional)*: The ID of the user requesting the monitor.
- **`alertWhenAvailable`** *(boolean, optional)*: Whether to alert when it drops. Default: `true`.

*(Other tools for internal quote management, okx payment verification, and ledger querying are also available: `create_payment_from_quote`, `get_domain_quote`, `list_domain_quotes`, `create_payment`, `verify_payment`, `get_order_status`, `list_domain_ledger_records`, `get_domain_ledger_record`, `monitor_domain_for_customer`, `list_domain_monitors`, `remove_domain_monitor`, `check_domain_monitor`, `check_all_domain_monitors`).*

---

## 🚀 Usage Examples

### Example 1: Standard Informational Request (Free)

Agents can call standard tools without incurring any cost. The x402 gateway dynamically prices these requests at `$0.00` and allows them through instantly.

**Request (`search_domain`):**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_domain",
    "arguments": {
      "domainName": "tmdefi.xyz",
      "showPrice": true,
      "currency": "USD"
    }
  }
}
```

### Example 2: Premium Tool Request & x402 Payment Flow

When an agent attempts to execute a premium tool like `purchase_domain`, the server halts the request to demand upfront payment.

**Step 1: Agent makes the initial unpaid request**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "purchase_domain",
    "arguments": {
      "domainName": "tmdefi.xyz",
      "idempotencyKey": "req_12345",
      "years": 1,
      "registrationContact": {
        "registrantName": "Alice Test",
        "email": "alice@example.com",
        "phone": "5550100",
        "address": "123 Test St",
        "city": "Testville",
        "country": "US",
        "postalCode": "90210"
      }
    }
  }
}
```

**Step 2: Server responds with 402 Payment Required**
The server queries Dynadot for a real-time quote, blocks the execution, and returns an HTTP `402` response containing a `Www-Authenticate` challenge detailing the exact price.

*Response Headers:*
```http
Www-Authenticate: L402 macaroon="...", invoice="...", amount="53.00", asset="USDT0", network="eip155:196", payTo="0xcc6900f6cc2877477b10aeb76912d113490a0e99"
```

**Step 3: Client pays and re-submits (Paid Request)**
The user executes a blockchain transaction transferring the requested `$53.00 USDT0` to the `payTo` treasury wallet. The client then cryptographically signs the payment payload and resubmits the exact same JSON-RPC body, attaching the signature.

*Request Headers:*
```http
x402-payment-signature: 0xabcd1234...
```

**Step 4: Server validates and executes**
The OKX Facilitator verifies the signature and confirms on-chain settlement. The gate unlocks, the domain is permanently registered via Dynadot, and the agent receives a `200 OK` JSON-RPC response with the registration receipts.

---

## Configuration Setup

The MCP Server is configured using `.env`. A treasury wallet is required to collect domain purchase payments securely. 

```env
# OKX/EVM Treasury wallet for collecting domain purchase payments
OKX_WALLET_ADDRESS=0xcc6900f6cc2877477b10aeb76912d113490a0e99
OKX_NETWORK=eip155:196

# Dynadot Integration
DYNADOT_ENV=live
DYNADOT_LIVE_API_KEY=your_key
DYNADOT_LIVE_API_SECRET=your_secret
```
