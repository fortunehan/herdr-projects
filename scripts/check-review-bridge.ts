import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(root, ".review-bridge-check-"));
try {
  /** Native checks restrict imports to their mod directory, so bundle repository imports into one disposable mod. */
  const result = await Bun.build({
    entrypoints: [join(root, "test/native-review-bridge/main.js")], outdir: scratch,
    target: "browser", external: ["herdr", "gpui-kit", "gpui-base", "fs/promises"],
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not bundle native bridge harness");
  copyFileSync(join(root, "test/native-review-bridge/mod.json"), join(scratch, "mod.json"));
  const check = Bun.spawn(["herdr-app", "check", scratch], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = await check.exited;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
