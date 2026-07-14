import crypto from "node:crypto";
import type { OkxPaymentConfig } from "./config.js";

export interface PaymentVerificationInput {
  paymentId: string;
  expectedAmount?: string;
  expectedCurrency?: string;
}

export interface CreatePaymentInput {
  amount: string;
  symbol: string;
  recipient: string;
  description?: string;
  externalId?: string;
  expiresIn?: number;
  realm?: string;
}

export interface CreatePaymentResult {
  paymentId: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
  challenge?: unknown;
  deliveries?: unknown;
  raw: unknown;
}

export interface PaymentVerificationResult {
  id: string;
  status: string;
  amount?: string;
  currency?: string;
  asset?: string;
  network?: string;
  raw: unknown;
}

export class OkxPaymentClient {
  private readonly config: OkxPaymentConfig;

  constructor(config: OkxPaymentConfig) {
    this.config = config;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.assertCreateConfigured();

    const response = await this.request("POST", this.config.createPath, {
      type: "charge",
      amount: input.amount,
      symbol: input.symbol,
      recipient: input.recipient,
      description: input.description,
      externalId: input.externalId,
      expiresIn: input.expiresIn,
      realm: input.realm,
      deliveries: {
        includeUrl: true
      }
    });

    const payment = this.extractPayment(response);

    return {
      paymentId: this.readString(payment, ["paymentId", "id"]) ?? "",
      status: this.readString(payment, ["status"]) ?? "",
      createdAt: this.readString(payment, ["createdAt"]),
      expiresAt: this.readString(payment, ["expiresAt"]),
      challenge: payment.challenge,
      deliveries: payment.deliveries,
      raw: response
    };
  }

  async verifyPayment(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    this.assertStatusConfigured();

    const path = this.interpolatePath(this.config.statusPath, input.paymentId);
    const response = await this.request("GET", path);
    const payment = this.extractPayment(response);
    const result = this.normalizePayment(input.paymentId, payment, response);

    this.assertPaymentMatches(result, input);

    return result;
  }

  private async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const requestBody = body ? JSON.stringify(this.compactObject(body)) : "";
    const signature = this.sign(timestamp, method, normalizedPath, requestBody);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };

    if (method === "POST") {
      headers["OK-ACCESS-KEY"] = this.config.apiKey;
      headers["OK-ACCESS-SIGN"] = signature;
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-PASSPHRASE"] = this.config.apiPassphrase;
    }

    if (method === "POST" && this.config.projectId) {
      headers["OK-ACCESS-PROJECT"] = this.config.projectId;
    }

    const response = await fetch(`${this.baseUrl()}${normalizedPath}`, {
      method,
      headers,
      body: requestBody || undefined
    });

    const text = await response.text();
    const data = text ? this.parseResponse(text) : null;

    if (!response.ok) {
      throw new Error(`OKX ${response.status} ${response.statusText}: ${text}`);
    }

    return data;
  }

  private assertPaymentMatches(result: PaymentVerificationResult, input: PaymentVerificationInput) {
    if (result.status.toUpperCase() !== this.config.requiredStatus.toUpperCase()) {
      throw new Error(`Payment ${result.id} status is ${result.status}; expected ${this.config.requiredStatus}.`);
    }

    if (input.expectedAmount && result.amount && result.amount !== input.expectedAmount) {
      throw new Error(`Payment ${result.id} amount is ${result.amount}; expected ${input.expectedAmount}.`);
    }

    if (input.expectedCurrency && result.currency && result.currency.toUpperCase() !== input.expectedCurrency.toUpperCase()) {
      throw new Error(`Payment ${result.id} currency is ${result.currency}; expected ${input.expectedCurrency}.`);
    }

    if (this.config.expectedAsset && result.asset && result.asset.toUpperCase() !== this.config.expectedAsset.toUpperCase()) {
      throw new Error(`Payment ${result.id} asset is ${result.asset}; expected ${this.config.expectedAsset}.`);
    }

    if (this.config.expectedNetwork && result.network && result.network.toUpperCase() !== this.config.expectedNetwork.toUpperCase()) {
      throw new Error(`Payment ${result.id} network is ${result.network}; expected ${this.config.expectedNetwork}.`);
    }
  }

  private assertCreateConfigured() {
    const missing = [
      ["OKX_API_KEY", this.config.apiKey],
      ["OKX_API_SECRET", this.config.apiSecret],
      ["OKX_API_PASSPHRASE", this.config.apiPassphrase],
      ["OKX_PAYMENT_CREATE_PATH", this.config.createPath]
    ].filter(([, value]) => !value);

    if (missing.length > 0) {
      throw new Error(`Missing OKX payment config: ${missing.map(([name]) => name).join(", ")}.`);
    }
  }

  private assertStatusConfigured() {
    if (!this.config.statusPath) {
      throw new Error("Missing OKX payment config: OKX_PAYMENT_STATUS_PATH.");
    }
  }

  private sign(timestamp: string, method: string, path: string, body: string) {
    return crypto
      .createHmac("sha256", this.config.apiSecret)
      .update(`${timestamp}${method}${path}${body}`)
      .digest("base64");
  }

  private interpolatePath(pathTemplate: string, paymentConfirmationId: string) {
    const encodedId = encodeURIComponent(paymentConfirmationId);

    if (pathTemplate.includes("{paymentId}")) {
      return pathTemplate.replaceAll("{paymentId}", encodedId);
    }

    if (pathTemplate.includes(":paymentId")) {
      return pathTemplate.replaceAll(":paymentId", encodedId);
    }

    return `${pathTemplate.replace(/\/+$/, "")}/${encodedId}`;
  }

  private extractPayment(response: unknown): Record<string, unknown> {
    if (!response || typeof response !== "object") {
      throw new Error("OKX payment response was empty or invalid.");
    }

    const objectResponse = response as Record<string, unknown>;
    const responseCode = this.readString(objectResponse, ["code"]);

    if (responseCode && responseCode !== "0") {
      const message = this.readString(objectResponse, ["msg", "message"]) ?? "Unknown OKX business error.";
      throw new Error(`OKX business error ${responseCode}: ${message}`);
    }

    const data = objectResponse.data;

    if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
      return data[0] as Record<string, unknown>;
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }

    return objectResponse;
  }

  private normalizePayment(id: string, payment: Record<string, unknown>, raw: unknown): PaymentVerificationResult {
    return {
      id: this.readString(payment, ["paymentConfirmationId", "paymentId", "orderId", "id"]) ?? id,
      status: this.readString(payment, ["status", "state", "paymentStatus"]) ?? "",
      amount: this.readString(payment, ["amount", "paidAmount", "totalAmount"]),
      currency: this.readString(payment, ["currency", "fiatCurrency"]),
      asset: this.readString(payment, ["asset", "token", "coin", "settlementAsset"]),
      network: this.readString(payment, ["network", "chain", "chainName"]),
      raw
    };
  }

  private readString(object: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
    }

    return undefined;
  }

  private baseUrl() {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private compactObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined && entryValue !== "")
        .map(([key, entryValue]) => {
          if (entryValue && typeof entryValue === "object" && !Array.isArray(entryValue)) {
            return [key, this.compactObject(entryValue as Record<string, unknown>)];
          }

          return [key, entryValue];
        })
    );
  }

  private parseResponse(text: string) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
