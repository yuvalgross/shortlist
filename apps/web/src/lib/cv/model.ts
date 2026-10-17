import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { CV_PARSE_SYSTEM, cvParseUserMessage } from "./prompt";
import { cvParseSchema, type RawParse } from "./schema";

export type ModelResult = { raw: RawParse; model: string; usage: { input_tokens: number; output_tokens: number } };
export type ModelCall = (cvText: string) => Promise<ModelResult>;

export const DEFAULT_PARSE_MODEL = "claude-sonnet-5-5";

// The real call to the matching model. Only runs on the server; the key never reaches the browser.
// 16k output tokens is several times what a long CV needs. Above about 21k the SDK refuses a plain request.
// The timeout keeps the call inside the 300 second limit of the Vercel function that runs it.
export const PARSE_MAX_TOKENS = 16000;
const PARSE_TIMEOUT_MS = 240_000;

export function claudeModelCall(
  apiKey: string,
  model = process.env.CV_PARSE_MODEL || DEFAULT_PARSE_MODEL,
  fetchImpl?: typeof fetch,
): ModelCall {
  const client = new Anthropic({ apiKey, timeout: PARSE_TIMEOUT_MS, maxRetries: 1, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return async (cvText) => {
    const res = await client.messages.parse({
      model,
      max_tokens: PARSE_MAX_TOKENS,
      system: CV_PARSE_SYSTEM,
      messages: [{ role: "user", content: cvParseUserMessage(cvText) }],
      output_config: { format: jsonSchemaOutputFormat(cvParseSchema, { transform: false }) },
    });
    if (res.stop_reason === "max_tokens") {
      throw new Error("The matching model ran out of room before finishing the CV.");
    }
    if (!res.parsed_output) {
      throw new Error(`The matching model returned no result (stop reason: ${res.stop_reason ?? "unknown"}).`);
    }
    return {
      raw: res.parsed_output as unknown as RawParse,
      model,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  };
}
