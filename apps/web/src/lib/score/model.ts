import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { JOB_SCORE_SYSTEM } from "./prompt";
import { jobScoreSchema, type RawScore } from "./schema";
import { UserFacingError } from "@/lib/cv/errors";

export type ScoreModelResult = { raw: RawScore; model: string; usage: { input_tokens: number; output_tokens: number } };
export type ScoreModelCall = (userMessage: string) => Promise<ScoreModelResult>;

export const DEFAULT_SCORE_MODEL = "claude-sonnet-5-5";
// A score is a short answer; 6k tokens leaves room for long reason lists. The user waits on the page,
// so one attempt of at most 100 seconds, inside the page's 120 second limit.
export const SCORE_MAX_TOKENS = 6000;
export const SCORE_TIMEOUT_MS = 100_000;

export function claudeScoreCall(
  apiKey: string,
  model = process.env.SCORE_MODEL || DEFAULT_SCORE_MODEL,
  fetchImpl?: typeof fetch,
): ScoreModelCall {
  const client = new Anthropic({ apiKey, timeout: SCORE_TIMEOUT_MS, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return async (userMessage) => {
    const cutOff = new UserFacingError("The score came back cut off. Try again with only the job ad text, without the rest of the page.");
    // A reply cut off at the token limit is usually broken JSON, which the SDK rejects before we see the stop reason.
    const res = await client.messages
      .parse({
        model,
        max_tokens: SCORE_MAX_TOKENS,
        system: JOB_SCORE_SYSTEM,
        messages: [{ role: "user", content: userMessage }],
        output_config: { format: jsonSchemaOutputFormat(jobScoreSchema, { transform: false }) },
      })
      .catch((err: unknown) => {
        if (/parse structured output/i.test(String((err as Error)?.message))) throw cutOff;
        throw err;
      });
    if (res.stop_reason === "max_tokens") throw cutOff;
    if (!res.parsed_output) {
      throw new Error(`The matching model returned no score (stop reason: ${res.stop_reason ?? "unknown"}).`);
    }
    return {
      raw: res.parsed_output as unknown as RawScore,
      model,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  };
}
