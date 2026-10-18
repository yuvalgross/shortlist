import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeModelCall, PARSE_MAX_TOKENS } from "@/lib/cv/model";
import { UserFacingError } from "@/lib/cv/errors";

// Sends the real request through the Anthropic SDK to a fake server, so SDK side checks run
// (the first live upload failed on one of these before any request left the server).
const raw = readFileSync(join(__dirname, "fixtures", "fictional-cv.model-output.json"), "utf8");

function fakeApi(stop_reason = "end_turn") {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "text", text: raw }], stop_reason, stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 800 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe("the call to the matching model", () => {
  it("is accepted by the SDK and returns the parsed result", async () => {
    const { fetchImpl, sent } = fakeApi();
    const res = await claudeModelCall("sk-test", "claude-sonnet-5-5", fetchImpl)("CV text");
    expect(sent).toHaveLength(1);
    expect(sent[0].max_tokens).toBe(PARSE_MAX_TOKENS);
    expect(sent[0].stream).toBeUndefined();
    expect(res.raw.experiences.length).toBeGreaterThan(0);
    expect(res.usage).toEqual({ input_tokens: 1200, output_tokens: 800 });
  });

  it("a cut off answer is a user facing error (shorter CV), not a generic 'try again'", async () => {
    const { fetchImpl } = fakeApi("max_tokens");
    const call = claudeModelCall("sk-test", "claude-sonnet-5-5", fetchImpl)("CV text");
    await expect(call).rejects.toBeInstanceOf(UserFacingError);
    await expect(claudeModelCall("sk-test", "claude-sonnet-5-5", fakeApi("max_tokens").fetchImpl)("CV text")).rejects.toThrow(/too long/);
  });
});
