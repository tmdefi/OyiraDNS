import type { GeminiConfig } from "./config.js";

export interface GeminiInteractionResult {
  model: string;
  outputText: string;
  raw: unknown;
}

export class GeminiClient {
  private readonly config: GeminiConfig;

  constructor(config: GeminiConfig) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.apiKey);
  }

  async createInteraction(input: string): Promise<GeminiInteractionResult> {
    if (!this.config.apiKey) {
      throw new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY.");
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/interactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey
      },
      body: JSON.stringify({
        model: this.config.model,
        input
      })
    });

    const rawText = await response.text();
    const raw = this.parseJson(rawText);

    if (!response.ok) {
      throw new Error(`Gemini request failed with ${response.status}: ${this.extractError(raw) ?? rawText}`);
    }

    return {
      model: this.config.model,
      outputText: this.extractOutputText(raw),
      raw
    };
  }

  private parseJson(rawText: string) {
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      return rawText;
    }
  }

  private extractOutputText(raw: unknown): string {
    if (!raw || typeof raw !== "object") {
      return typeof raw === "string" ? raw : "";
    }

    const record = raw as Record<string, unknown>;

    if (typeof record.output_text === "string") {
      return record.output_text;
    }

    if (typeof record.outputText === "string") {
      return record.outputText;
    }

    return this.collectText(raw).join("\n").trim();
  }

  private collectText(value: unknown): string[] {
    if (!value || typeof value !== "object") {
      return [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((entry) => this.collectText(entry));
    }

    const record = value as Record<string, unknown>;
    const directText = typeof record.text === "string" ? [record.text] : [];

    return [
      ...directText,
      ...Object.entries(record)
        .filter(([key]) => key !== "text")
        .flatMap(([, entry]) => this.collectText(entry))
    ];
  }

  private extractError(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const error = record.error;

    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }

    return null;
  }
}
