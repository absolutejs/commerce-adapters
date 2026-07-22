import { CUSTOMCAT_API_BASE_URL } from "./constants";

export type CustomCatHttpConfig = {
  apiKey: string;
  baseUrl?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type JsonRecord = Record<string, unknown>;

export const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringValue = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export const createCustomCatRequest = (config: CustomCatHttpConfig) => {
  if (!config.apiKey.trim()) throw new Error("CustomCat API key is required");
  const fetcher = config.fetch ?? globalThis.fetch;
  const baseUrl = (config.baseUrl ?? CUSTOMCAT_API_BASE_URL).replace(/\/$/, "");

  return async (
    path: string,
    init?: RequestInit,
    includeKeyInQuery = false,
  ): Promise<unknown> => {
    const url = new URL(`${baseUrl}${path}`);
    if (includeKeyInQuery) url.searchParams.set("api_key", config.apiKey);
    const response = await fetcher(url, init);
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { result: text };
    }
    const failure = record(payload)
      ? (payload.error_description ?? payload.error ?? payload.message)
      : undefined;
    if (!response.ok || failure)
      throw new Error(
        stringValue(failure) ||
          response.headers.get("x-fail-message") ||
          `CustomCat request failed (${response.status})`,
      );

    return payload;
  };
};
