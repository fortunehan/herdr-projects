import { expect, test } from "bun:test";
import { act } from "./actions.ts";

test("the settings picker can pin provider-qualified magpie models", async () => {
  const pinned: string[] = [];
  const compat = { agents: { pin(agent: string, model: string) { pinned.push(`${agent}:${model}`); return { pinned, recent: [] }; } } };
  const result = await act({} as never, { type: "model-pin", agent: "claude", model: "openrouter/vendor/model" }, compat as never);
  expect(result).toEqual({ ok: true, picks: { pinned: ["claude:openrouter/vendor/model"], recent: [] } });
});
