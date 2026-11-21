# Azure DevOps has its own way from Accept to Done

Azure DevOps was first added as a second forge read "in gh's shapes", so herdr-task's Accept, tick and merge code treated its pull requests as GitHub's. Its workflow differs: the person's Accept often can't complete a pull request (reviewer approvals by others are required), so Accept turns on auto-complete and the task waits in its own status, Waiting to merge, until Azure DevOps merges it; then the main checkout is pulled and a failed pull is the person's to know. We decided (SHEP-33) that the Azure DevOps path from Accept to Done lives in its own module, and GitHub's code behaves exactly as before, rather than adding more Azure DevOps branches inside the GitHub flow.

## Consequences

- Reading a pull request (checks, comments, builds) may still share gh's shapes; deciding what Accept does, what the task waits on and what happens after the merge is per forge.
- The pull-and-tell-on-failure after a merge is Azure DevOps only; GitHub keeps its silent fast-forward.
- Since SHEP-96 its pull request is opened after Accept by the task's agent, with the ado-push-pr skill (ADR 0003).
