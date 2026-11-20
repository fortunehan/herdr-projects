# On Azure DevOps the task's agent opens the pull request after Accept

Until SHEP-96, `herdr-task ready` on an Azure DevOps worktree task pushed the branch and opened its pull request itself (`ado.pr_open()`, following the ado-push-pr skill's conventions by hand). A pull request then existed for work the person had not yet looked at, and Herdr kept a second copy of the skill's rules (work item, title, template) that drifted from the skill. We decided (SHEP-96) that on Azure DevOps ready pushes nothing and opens no pull request: the person reviews the task's branch against its base, its proof and summary, and the Accept card says the pull request comes on Accept. Their Accept hands opening it to the task's agent, resumed when it has ended, with a message to use the ado-push-pr skill into the task's base with auto-complete on, then to record it with `herdr-task pr <id> --url <its URL>`. The task reads Opening pull request meanwhile, then Waiting to merge as before (ADR 0001).

A failing check while it waits to merge goes to the task's agent to fix: commit and `git push`, never ready again, never a force-push. Each new failure (a new head, or other checks failing) is one fix round. The task has at most `tasks.fix_rounds` of them per pull request (default 3; Settings > Tasks > Fix checks, beside Merge; `--set fix_rounds=N` per task; shown in its brief's Settings block as Fix rounds), after which it needs the person with the last failure. A round is one pushed commit: more checks of the same push failing later belong to the round it is on. A reviewer's vote is passed on as news, never a fix round. A passing run resets nothing. An agent that has ended is started again with the failure.

## Considered options

- Ready still pushes the branch as a backup without a pull request: rejected by the person. A pushed `task/...` branch becomes the upstream the skill keeps whatever its name, so it would bypass the skill's rule for new remote branch names (`feature/...`, `bugfix/...`).
- Herdr keeps opening the pull request itself on Accept: rejected. The skill is the one place its conventions live, and the agent can recover from what the skill reports (a missing work item, a refused push) in its own words.

## Consequences

- When the agent can't open the pull request (no valid work item, a refused push, the skill missing), it says so with `herdr-task status … --cant-fix "<why>"`, and the task needs the person with that reason ("Couldn't open the pull request"). The same applies when the agent ends its turn without recording one, or stops. Herdr never falls back to opening the pull request itself. The person's Accept asks the agent again.
- The message names the task branch as the remote branch to push (an explicit name, which the skill allows), so Herdr's `task/...` branches pass the skill's rule for new branch names.
- `herdr-task pr` is refused before an Accept, and for a pull request from another branch or at another commit than the one the person accepted.
- Settings' Merge "on its own" or "after checks" stands for the person's Accept, as it did before: the agent is told so, not that the person accepted.
- A later ready never pushes or reopens a pull request its agent opened: the agent pushes to it itself.
- `--cant-fix` on a failing check, or fix rounds used up, keeps the task in Needs you with why until the pull request's head moves (a fix pushed), whatever its checks say meanwhile.
- While the agent opens the pull request or fixes checks, its turns don't take the task back to Working: that is the work it was asked for, as an agent merging locally on request.
- A task whose pull request was opened at ready before SHEP-96 goes on as ADR 0001 describes. GitHub is unchanged: ready still opens its pull request.
