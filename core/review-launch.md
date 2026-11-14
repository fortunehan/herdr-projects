# Changes Review launch bridge v1

This is the supported Shepherdr boundary for the dependent Annotator sidebar's **AI Review** button. It opens the existing `changes-review` dialog; **Run** remains a separate explicit action. Do not change Annotator's center presentation, Open review, annotations, previews, comparisons or layout. No import from another installed mod is required.

## Capability and call

Use Herdr's public `shared`, `run` and `terminals` APIs. The active `tabs-tasks` host publishes `shared("changes.review.bridge")`:

```js
{ version: 1, instance: "opaque token", expires: 1234567890000,
  command: "tabs-tasks.review-open:", results: "changes.review.launch-results" }
```

The capability is renewed every 2.5 seconds and expires after ten seconds. Hide or disable AI Review with an explanation when missing, expired or an unknown version. Do not try a fallback mod, global target or focused checkout. Read it again on click. Capture everything below synchronously before any `await`, tab selection or overlay opening. Set a producer busy latch until the correlated result arrives.

```js
// Inside Annotator: location() and currentSession() are its existing bound helpers.
const cap = shared("changes.review.bridge");
if (!cap || cap.version !== 1 || cap.expires <= Date.now()) {
  // Display "AI Review is unavailable. Update/enable Shepherdr and try again."
  return;
}
const current = location();
const snapshot = this.data?.snapshot;
const source = this.currentSession();
const terminal = terminals().find(t => t.address === source?.address);
// Require !this.busy, !this.snapshotError, snapshot, and contextKey() === this.context.
// Require snapshot.scope's repo/machine and comparison to match this view's current target.
// Require source and terminal.foreground.pid; never choose a different source on failure.
const request = {
  version: 1,
  id: `annotator-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  bridge: cap.instance,
  at: Date.now(),
  target: {
    cwd: snapshot.scope.repo,
    on: snapshot.scope.machine ?? null,
    workspace: current.space,
    tab: current.tab,
    comparison: snapshot.scope.comparison ?? { mode: "uncommitted", base: null },
    head: snapshot.head,
    baseline: snapshot.baseline,
    source: { address: source.address, pid: terminal.foreground.pid },
  },
};
run(cap.command + encodeURIComponent(JSON.stringify(request)));
```

The snippet shows transport and fields; the dependent producer must implement the guards, error display and result observation. `run`'s successful return means command admission, not an opened dialog. Poll/read the advertised results key while pending (including while the sidebar is hidden by the dialog). It is a bounded list of the latest sixteen results:

```js
{ id: "same request id", status: "opened" /* or "error" */,
  error: null /* or readable reason */, overlay: "overlay id" /* or null */, at: 1234567890000 }
```

On `error`, show its reason and release the busy latch. If no result arrives within fifteen seconds, show “AI Review did not confirm opening. Check the open dialog before trying again.” Do not automatically repeat the request. A retry of the **same** request/id within the ten-second admission window is deduplicated, including while binding is in progress. Reusing an id with different data is an error. A new click gets a new id and capability. Other concurrent requests can receive “already opening”; they are not queued. The bridge retains deduplication entries for thirty seconds, bounded to sixty-four, and rejects requests older than ten seconds. Reloading the host invalidates its instance token.

## Target fields and comparison mapping

All paths and ids belong to the clicked view, not later global/focused state. Fields outside the documented request schema are rejected. `pending` and `retained` are optional boolean target flags; true rejects launch. Do not send report ids, guidance, model settings, delivery or repair actions.

| Field | Producer evidence / meaning |
| --- | --- |
| `cwd` | Absolute `snapshot.scope.repo`: the actual checkout/worktree, including followed task checkouts. No fallback to the main repository. |
| `on` | `snapshot.scope.machine`, null/absent for local. Remote targets are rejected. |
| `workspace`, `tab` | Captured `location().space` and `.tab`, local ids. The selected source must still belong to that workspace/tab, including a native Chat's parked terminal. |
| `source.address`, `source.pid` | Existing `currentSession().address`, then that terminal's current `foreground.pid`. The host verifies the process and resolves/pins its actual Claude/Codex conversation before opening the dialog. Other agent kinds are unsupported. |
| `head`, `baseline` | Snapshot commit hashes (or null for an unborn Uncommitted checkout). The host compares them to Git; stale or mismatched snapshots fail. |
| `comparison.mode`, `.base` | Use the **loaded snapshot** comparison, including the actual automatically chosen ref, not an empty ref input or an inferred upstream. |

| Producer mode | Existing review mode | Scope |
| --- | --- | --- |
| `uncommitted` | Uncommitted | Staged, unstaged and new files against captured HEAD/empty tree. `baseline` must equal `head`. |
| `branch` | Branch (`ref`) | Merge base of HEAD and the exact nonempty `comparison.base`, plus working files/new files. Annotator's automatic and explicit choices both use their resolved snapshot ref. |
| `base` | Base | Same exact-ref behavior, displayed as Base. Reserved for producers with a Base option; **current Annotator has no distinct Base mode**. |
| `last_commit` / any other mode | Rejected | No scope substitution. Ask the person to choose a supported comparison. |

Verified against Annotator's `review.js` (`reviewLocation`, `sessionTarget`), `main.js` (`location`, `currentSession`, snapshot refresh), and Rust `git.rs`/`model.rs`: snapshot scope returns the actual chosen branch ref, `head`, and `baseline` (HEAD for Uncommitted; merge base for Branch). The installed native Chat adapter also maps its parked terminals back to the source tab; obtain PID from `terminals()`, since the merged agent row does not carry it. No third-party source is copied here.

## Binding and failures

Before focus changes, the host checks the local workspace/tab, observes the checkout with the existing read-only capture, checks snapshot HEAD/baseline, verifies the selected process belongs to that checkout and resolves its conversation. The dialog receives this target as pinned props, never through `changes.review.target`. Another Changes view cannot replace it. Prepare, periodic checks and Run revalidate the checkout/gitdir/HEAD/ref/base and exact source conversation plus source-tab membership. Refresh cannot silently rebind a pinned launch: reopen from the intended Changes view when its identity changes. Source selection for a bridge launch contains only the bound conversation. The ordinary `my-changes` entry retains its existing target-following and source selection behavior.

Missing checkout, unknown refs, empty comparisons, conflicts, stale snapshots, unavailable/remote workspace, source replacement, permission errors and native overlay errors produce visible error results or the existing disabled/error dialog. There is no guessed target, default upstream, hidden model execution, report-delivery privilege or repair privilege in this command. Model/effort/depth defaults, report persistence, passive delivery and three-round recovery remain in the existing backend.

## Checks

- `bun test core/review-launch.test.js core/changes-review.test.js`: command parsing/dedup/errors, actual exported host adapter, source/tab binding, pinned dialog paths and existing lifecycle. Runtime transports are stubbed; Git lifecycle tests use disposable real repositories.
- `bun scripts/check-review-bridge.ts`: supported native renderer harness for the existing dialog using fixture data. It overrides live init, disables Run and starts no real review or agent. Do **not** check `tabs-tasks` itself: its init starts live services.
- `bin/sync-shared && bin/sync-shared --check`: canonical `core/` and `lib/` sources and every consuming mod, including tabs, chat and dialog.

These checks do not prove an Annotator AI Review button (delivered by the dependent task), live cross-mod command dispatch, or real model execution.
