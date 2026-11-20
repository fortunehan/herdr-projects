# Update after a Shepherdr task merges

For people who work on Shepherdr with Shepherdr. Once a task in your Shepherdr checkout merges, this machine can bring
that checkout up to date and reinstall itself. You no longer run `git fetch`, `git merge`, `./install.sh --yes` and
`shepherdr doctor` by hand after each Accept.

Shepherdr settings → Machines → *a machine* → **Update after a Shepherdr task merges**. It is off by default and set per
machine. On the web it is the same row on Settings › Machines.

## What it applies to

Only the folder Shepherdr was installed from on that machine: the `source` in its install record
(`~/.config/herdr-app/data/shepherdr/installed.json`, or `~/.local/share/shepherdr/installed.json` for a web-only
install). A task in any other repo never sets it off.

## When it runs

- A task in that folder merges through its pull request: you Accept it, it merges on GitHub or Azure DevOps, or the tick
  finds a merged pull request. A timer never starts it.
- It waits 3 minutes after the last merge. Each new merge in that time restarts the wait, so several merges close
  together lead to a single update. Each install reloads the big window mods, and too many reloads once filled
  Herdr's memory.
- Only one update runs at a time. A merge while one runs leads to exactly one more update after it.
- A due update waits while you are typing in a chat, or while the machine is busy by its Machines limits (memory, CPU,
  disk), for at most an hour.
- It runs in the background, started by herdr-task's scheduler (`herdr-automations`). It never blocks an agent's command.
  The install itself runs at low priority (`nice`).

## What it does

Each step must succeed, or the update stops there:

1. `git fetch <remote> <base>`.
2. It refuses a checkout that has uncommitted tracked changes, is in the middle of a merge, rebase, cherry-pick or
   revert, or is not on its base branch.
3. `git merge --no-edit <remote>/<base>`. This is always a merge commit: the local main often has commits the remote
   lacks, such as AGENTS.md notes. On a conflict it runs `git merge --abort` and stops.
4. `./install.sh --yes` from that checkout.
5. `shepherdr doctor`. The installer holds the sync to other machines until doctor finds the install whole.

It never pushes, and it never installs on another machine.

## What you hear

- **Updated:** the space's Assistant gets one line of news with the new version. If it can't take the news yet, the
  news waits for it.
- **Stopped:** an alert reaches you at once, and the Assistant hears it too. Both say what stopped it, the command to
  finish by hand, and the installer's backup folder when it got that far. A stopped update is never retried
  automatically. Merges that came in while it ran are dropped too; the command to finish by hand covers them.

`herdr-task self-update` shows whether it is on here, what waits, what runs and how the last update ended. Each update is
logged in `~/.local/share/shepherdr/tasks/.self-update.jsonl`.
