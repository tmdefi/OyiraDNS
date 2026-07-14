import crypto from "node:crypto";
import type { DynadotConfig } from "./config.js";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RegistrationContact {
  registrantName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  state?: string;
  postalCode?: string;
  organization?: string;
}

export interface DomainPushInput {
  domainName: string;
  targetAccount?: string;
  targetEmail?: string;
  message?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  requireSignature?: boolean;
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
      body: {
        domainName: input.domainName,
        duration: input.years ?? 1,
        currency: input.currency,
        nameServers: input.nameservers,
        paymentConfirmationId: input.paymentConfirmationId,
        registrationContact: input.registrationContact,
        registrantContact: input.registrationContact
      }
    });
  }

  getOrderStatus(orderId: string) {
    return this.request("GET", this.orderPath(orderId, "order_get_status"), {
      requireSignature: true
    });
  }

  setNameservers(domainName: string, nameservers: string[]) {
    return this.request("PUT", this.domainPath(domainName, "set_nameserver"), {
      requireSignature: true,
      body: {
        domainName,
        nameServers: nameservers
      }
    });
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

  private orderPath(identifier: string, action: string) {
    return `/restful/${this.config.apiVersion}/orders/${encodeURIComponent(identifier)}/${action}`;
  }

  private baseUrl() {
    return this.config.baseUrl.replace(/\/+$/, "");
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
