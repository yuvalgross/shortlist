import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { CV_PARSE_SYSTEM, cvParseUserMessage } from "./prompt";
import { cvParseSchema, type RawParse } from "./schema";
import { UserFacingError } from "./errors";

export type ModelResult = { raw: RawParse; model: string; usage: { input_tokens: number; output_tokens: number } };
export type ModelCall = (cvText: string) => Promise<ModelResult>;

export const DEFAULT_PARSE_MODEL = "claude-sonnet-5-5";

// The real call to the matching model. Only runs on the server; the key never reaches the browser.
// 16k output tokens is several times what a long CV needs. Above about 21k the SDK refuses a plain request.
// One attempt of at most 240 seconds, no automatic retry: a retry would push the worst case past the
// 300 second limit of the Vercel function, and the function would be killed before it could mark the upload failed.
export const PARSE_MAX_TOKENS = 16000;
export const PARSE_TIMEOUT_MS = 240_000;

export function claudeModelCall(
  apiKey: string,
  model = process.env.CV_PARSE_MODEL || DEFAULT_PARSE_MODEL,
  fetchImpl?: typeof fetch,
): ModelCall {
  const client = new Anthropic({ apiKey, timeout: PARSE_TIMEOUT_MS, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return async (cvText) => {
    const res = await client.messages.parse({
      model,
      max_tokens: PARSE_MAX_TOKENS,
      system: CV_PARSE_SYSTEM,
      messages: [{ role: "user", content: cvParseUserMessage(cvText) }],
      output_config: { format: jsonSchemaOutputFormat(cvParseSchema, { transform: false }) },
    });
    if (res.stop_reason === "max_tokens") {
      // Retrying gives the same result, so say what to change instead of "try again".
      throw new UserFacingError(
        "This CV is too long to read in one go. Upload a shorter version (two pages at most) and try again.",
      );
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
