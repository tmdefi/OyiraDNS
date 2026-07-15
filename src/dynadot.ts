import crypto from "node:crypto";
import type { DynadotConfig } from "./config.js";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RegistrationContact {
  registrantName: string;
  email: string;
  phone: string;
  phoneCountryCode?: string;
  address: string;
  city: string;
  country: string;
  state?: string;
  postalCode?: string;
  organization?: string;
}

export interface DynadotRegisterDomainRequest {
  domain: {
    duration: number;
    registrant_contact: DynadotRegisterContact;
    admin_contact: DynadotRegisterContact;
    tech_contact: DynadotRegisterContact;
    billing_contact: DynadotRegisterContact;
    name_server_list?: string[];
    privacy: "off" | "partial" | "full";
  };
}

export interface DynadotRegisterContact {
  organization?: string;
  name: string;
  email: string;
  phone_number: string;
  phone_cc: string;
  address1: string;
  city: string;
  state?: string;
  zip: string;
  country: string;
}

export interface DomainPushInput {
  domainName: string;
  targetAccount?: string;
  targetEmail?: string;
  message?: string;
}

export type DnsRecordType = "a" | "aaaa" | "cname" | "txt" | "mx" | "forward" | "srv" | "stealth" | "email";

export interface DnsRecordInput {
  type: DnsRecordType;
  name?: string;
  value: string;
  priority?: number;
  extra?: string | number;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  requireSignature?: boolean;
}

function parsePhone(phone: string, phoneCountryCode?: string) {
  const normalized = phone.trim().replace(/[()\s.-]/g, "");
  const match = normalized.match(/^(?:\+|00)([1-9]\d{0,3})(\d{4,14})$/);

  if (match) {
    return {
      countryCode: match[1],
      number: match[2]
    };
  }

  const normalizedCountryCode = phoneCountryCode?.trim().replace(/^\+/, "");
  const normalizedNumber = normalized.replace(/^\+/, "");

  if (!normalizedCountryCode || !/^[1-9]\d{0,3}$/.test(normalizedCountryCode) || !/^\d{4,14}$/.test(normalizedNumber)) {
    throw new Error(
      "Registration contact phone must include a phone country code, for example +14155550100, or provide phoneCountryCode such as 1, 44, or 234."
    );
  }

  return {
    countryCode: normalizedCountryCode,
    number: normalizedNumber
  };
}

export class DynadotClient {
  private readonly config: DynadotConfig;
  private readonly maxTransientAttempts = 3;

  constructor(config: DynadotConfig) {
    this.config = config;
  }

  searchDomain(domainName: string, options: { showPrice?: boolean; currency?: string } = {}) {
    return this.request("GET", this.domainPath(domainName, "search"), {
      query: {
        show_price: options.showPrice ? "true" : undefined,
        currency: options.currency
      }
    });
  }

  getTldPrice(tld: string, currency?: string) {
    return this.request("GET", `/restful/${this.config.apiVersion}/domains/get_tld_price`, {
      query: {
        currency: currency?.toLowerCase(),
        tlds: tld.replace(/^\./, ""),
        show_multi_year: "true"
      },
      requireSignature: true
    });
  }

  registerDomain(input: {
    domainName: string;
    years?: number;
    currency?: string;
    nameservers?: string[];
    paymentConfirmationId: string;
    registrationContact?: RegistrationContact;
  }) {
    if (this.config.env === "live" && !this.config.allowLivePurchases) {
      throw new Error("Live purchases are disabled. Set ALLOW_LIVE_PURCHASES=true to enable live registration.");
    }

    return this.request("POST", this.domainPath(input.domainName, "register"), {
      requireSignature: true,
      body: this.registerDomainRequest(input) as unknown as Record<string, unknown>
    });
  }

  registerDomainRequest(input: {
    years?: number;
    currency?: string;
    nameservers?: string[];
    registrationContact?: RegistrationContact;
  }): DynadotRegisterDomainRequest {
    if (!input.registrationContact) {
      throw new Error("Missing registration contact.");
    }

    const contact = this.toDynadotRegisterContact(input.registrationContact);

    return {
      domain: this.compactObject({
        duration: input.years ?? 1,
        registrant_contact: contact,
        admin_contact: contact,
        tech_contact: contact,
        billing_contact: contact,
        name_server_list: input.nameservers,
        privacy: "full"
      }) as DynadotRegisterDomainRequest["domain"],
      // Dynadot register treats currency as optional and uses the account default.
      // Omitting it avoids API enum parsing drift while quotes still use explicit USD pricing.
    };
  }

  getOrderStatus(orderId: string) {
    return this.request("GET", this.orderPath(orderId, "order_get_status"), {
      requireSignature: true
    });
  }

  setNameservers(domainName: string, nameservers: string[]) {
    if (!this.config.allowNameserverChanges) {
      throw new Error("Nameserver changes are disabled. Set ALLOW_NAMESERVER_CHANGES=true to enable nameserver updates.");
    }

    return this.request("PUT", this.domainPath(domainName, "set_nameserver"), {
      requireSignature: true,
      body: {
        domainName,
        nameServers: nameservers
      }
    });
  }

  setDns2(input: { domainName: string; records: DnsRecordInput[]; ttl?: number; append?: boolean }) {
    if (!this.config.allowDnsChanges) {
      throw new Error("DNS changes are disabled. Set ALLOW_DNS_CHANGES=true to enable DNS record updates.");
    }

    const query: Record<string, string | number | boolean | undefined> = {
      domain: input.domainName.trim().toLowerCase(),
      ttl: input.ttl,
      add_dns_to_current_setting: input.append ? 1 : undefined
    };
    let rootIndex = 0;
    let subdomainIndex = 0;

    for (const record of input.records) {
      const name = normalizeDnsName(record.name);
      const type = normalizeDnsRecordType(record.type);
      const value = record.value.trim();

      if (!value) {
        throw new Error("DNS record value cannot be empty.");
      }

      if (name === "@" || name === "") {
        if (rootIndex >= 20) {
          throw new Error("Dynadot set_dns2 supports at most 20 root records.");
        }

        query[`main_record_type${rootIndex}`] = type;
        query[`main_record${rootIndex}`] = value;
        const extra = dnsRecordExtra(record);
        if (extra !== undefined) {
          query[`main_recordx${rootIndex}`] = extra;
        }
        rootIndex += 1;
        continue;
      }

      if (subdomainIndex >= 99) {
        throw new Error("Dynadot set_dns2 supports at most 99 subdomain records.");
      }

      query[`subdomain${subdomainIndex}`] = name;
      query[`sub_record_type${subdomainIndex}`] = type;
      query[`sub_record${subdomainIndex}`] = value;
      const extra = dnsRecordExtra(record);
      if (extra !== undefined) {
        query[`sub_recordx${subdomainIndex}`] = extra;
      }
      subdomainIndex += 1;
    }

    if (rootIndex === 0 && subdomainIndex === 0) {
      throw new Error("At least one DNS record is required.");
    }

    return this.api3Request("set_dns2", query);
  }

  pushDomain(input: DomainPushInput) {
    if (!this.config.allowDomainPushes) {
      throw new Error("Domain pushes are disabled. Set ALLOW_DOMAIN_PUSHES=true to enable account pushes.");
    }

    return this.request("POST", this.domainPath(input.domainName, "push"), {
      requireSignature: true,
      body: {
        domainName: input.domainName,
        targetAccount: input.targetAccount,
        accountName: input.targetAccount,
        recipientAccount: input.targetAccount,
        targetEmail: input.targetEmail,
        email: input.targetEmail,
        recipientEmail: input.targetEmail,
        message: input.message
      }
    });
  }

  async request(method: HttpMethod, path: string, options: RequestOptions = {}) {
    this.assertConfigured(options.requireSignature ?? false);

    const maxAttempts = method === "GET" ? this.maxTransientAttempts : 1;
    const queryString = this.toQueryString(options.query);
    const fullPathAndQuery = `${path}${queryString}`;
    const requestBody = options.body ? JSON.stringify(this.compactObject(options.body)) : "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestId = crypto.randomUUID();
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": requestId
      };

      if (this.config.apiSecret) {
        headers["X-Signature"] = this.createSignature(fullPathAndQuery, requestId, requestBody);
      }

      try {
        const response = await fetch(`${this.baseUrl()}${fullPathAndQuery}`, {
          method,
          headers,
          body: requestBody || undefined
        });

        const text = await response.text();
        const data = text ? this.parseResponse(text) : null;

        if (!response.ok) {
          if (attempt < maxAttempts && this.isTransientDynadotFailure(response.status, text)) {
            await this.delay(this.retryDelayMs(attempt));
            continue;
          }

          throw new Error(`Dynadot ${response.status} ${response.statusText}: ${text}`);
        }

        this.assertSuccessfulResponse(data);

        return data;
      } catch (error) {
        if (attempt < maxAttempts && this.isTransientRequestError(error)) {
          await this.delay(this.retryDelayMs(attempt));
          continue;
        }

        throw error;
      }
    }

    throw new Error("Dynadot request failed after retry attempts.");
  }

  private domainPath(identifier: string, action: string) {
    return `/restful/${this.config.apiVersion}/domains/${encodeURIComponent(identifier)}/${action}`;
  }

  private toDynadotRegisterContact(contact: RegistrationContact): DynadotRegisterContact {
    const phone = parsePhone(contact.phone, contact.phoneCountryCode);

    if (!contact.postalCode?.trim()) {
      throw new Error("Missing registration contact postalCode. Dynadot register requires zip.");
    }

    return this.compactObject({
      organization: contact.organization,
      name: contact.registrantName,
      email: contact.email,
      phone_number: phone.number,
      phone_cc: phone.countryCode,
      address1: contact.address,
      city: contact.city,
      state: contact.state,
      zip: contact.postalCode,
      country: contact.country.toUpperCase()
    }) as unknown as DynadotRegisterContact;
  }

  private orderPath(identifier: string, action: string) {
    return `/restful/${this.config.apiVersion}/orders/${encodeURIComponent(identifier)}/${action}`;
  }

  private baseUrl() {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private api3BaseUrl() {
    const baseUrl = this.baseUrl();
    return `${baseUrl}/api3.json`;
  }

  private assertConfigured(requireSignature: boolean) {
    if (!this.config.apiKey) {
      throw new Error(`Missing Dynadot ${this.config.env} API key.`);
    }

    if (requireSignature && !this.config.apiSecret) {
      throw new Error(`Missing Dynadot ${this.config.env} API secret for signed request.`);
    }
  }

  private createSignature(fullPathAndQuery: string, requestId: string, requestBody: string) {
    const stringToSign = `${this.config.apiKey}\n${fullPathAndQuery}\n${requestId}\n${requestBody}`;

    return crypto
      .createHmac("sha256", Buffer.from(this.config.apiSecret, "utf8"))
      .update(Buffer.from(stringToSign, "utf8"))
      .digest("base64");
  }

  private toQueryString(query: RequestOptions["query"]) {
    if (!query) {
      return "";
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        params.set(key, String(value));
      }
    }

    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
  }

  private compactObject(value: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== "")
    );
  }

  private parseResponse(text: string) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async api3Request(command: string, query: Record<string, string | number | boolean | undefined>) {
    this.assertConfigured(false);

    const params = new URLSearchParams();
    params.set("key", this.config.apiKey);
    params.set("command", command);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        params.set(key, String(value));
      }
    }

    const response = await fetch(`${this.api3BaseUrl()}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });
    const text = await response.text();
    const data = text ? this.parseResponse(text) : null;

    if (!response.ok) {
      throw new Error(`Dynadot API3 ${response.status} ${response.statusText}: ${text}`);
    }

    this.assertApi3SuccessfulResponse(data);

    return data;
  }

  private assertSuccessfulResponse(data: unknown) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return;
    }

    const code = (data as Record<string, unknown>).code ?? (data as Record<string, unknown>).Code;

    if (typeof code !== "number" && typeof code !== "string") {
      return;
    }

    const numericCode = Number(code);

    if (Number.isFinite(numericCode) && numericCode >= 400) {
      throw new Error(`Dynadot business error ${code}: ${JSON.stringify(data)}`);
    }
  }

  private assertApi3SuccessfulResponse(data: unknown) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Dynadot API3 returned an invalid response: ${JSON.stringify(data)}`);
    }

    const responseEntry = Object.values(data as Record<string, unknown>).find(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ) as Record<string, unknown> | undefined;

    if (!responseEntry) {
      throw new Error(`Dynadot API3 returned an invalid response: ${JSON.stringify(data)}`);
    }

    const status = String(responseEntry.Status ?? responseEntry.status ?? "").toLowerCase();
    const responseCode = String(responseEntry.ResponseCode ?? responseEntry.SuccessCode ?? "");

    if (status !== "success" && responseCode !== "0") {
      const error = responseEntry.Error ?? responseEntry.error ?? JSON.stringify(data);
      throw new Error(`Dynadot API3 business error: ${error}`);
    }
  }

  private isTransientDynadotFailure(status: number, text: string) {
    const normalizedText = text.toLowerCase();
    return (
      [502, 503, 504].includes(status) ||
      (status === 500 && normalizedText.includes("registry connection busy")) ||
      normalizedText.includes("registry connection busy")
    );
  }

  private isTransientRequestError(error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("registry connection busy") ||
      message.includes("dynadot business error 502") ||
      message.includes("dynadot business error 503") ||
      message.includes("dynadot business error 504") ||
      message.includes("fetch failed") ||
      message.includes("econnreset") ||
      message.includes("etimedout") ||
      message.includes("network")
    );
  }

  private retryDelayMs(attempt: number) {
    return 400 * 2 ** (attempt - 1);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function normalizeDnsName(name: string | undefined) {
  const value = (name ?? "@").trim().toLowerCase();
  return value === "." || value === "root" ? "@" : value;
}

function normalizeDnsRecordType(type: string) {
  const normalized = type.trim().toLowerCase();
  const allowed = new Set(["a", "aaaa", "cname", "txt", "mx", "forward", "srv", "stealth", "email"]);

  if (!allowed.has(normalized)) {
    throw new Error(`Unsupported DNS record type: ${type}.`);
  }

  return normalized;
}

function dnsRecordExtra(record: DnsRecordInput) {
  if (record.extra !== undefined) {
    return record.extra;
  }

  if (record.type.toLowerCase() === "mx" && record.priority !== undefined) {
    return record.priority;
  }

  return undefined;
}
