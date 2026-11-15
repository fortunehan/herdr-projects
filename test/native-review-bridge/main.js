import ReviewDialog from "../../mods/changes-review/main.js";
import { InputState, TextareaState } from "gpui-base";
import { DEFAULT_MODEL, sourceKey } from "../../core/changes-review.js";

/** Supported `herdr-app check` harness: render the real dialog; never run its live init or transports. */
export default class BridgeHarness extends ReviewDialog {
  init() {
    const target = { cwd: "/fixture/checkout", root: "/fixture/checkout", mode: "ref", ref: "chosen/topic", workspace: "fixture-space" };
    const source = { address: "fixture-source", conversation: "fixture-conversation", pid: 1, root: target.root, kind: "codex", name: "Fixture Source" };
    this.p = { target, bound: true };
    this.form = { target, models: [{ id: DEFAULT_MODEL, name: "GPT-6-Astra · Codex" }], model: DEFAULT_MODEL,
      effort: "high", depth: "high", guidance: "", sources: [source], source: sourceKey(source),
      error: "Harness only: Run is disabled. No model or agent execution.", loading: false };
    this.prompt = TextareaState.new({ placeholder: "Optional supplementary guidance" });
    this.search = InputState.new({ placeholder: "Search configured models" });
  }
  refresh() {}
  launch() {}
  close() { this.prompt.release(); this.search.release(); }
}
