# Claude launcher settings

These wrappers use `bin/shepherdr-claude-settings` to give Claude one settings
file containing the selected launcher's route and the caller's UI settings.
The helper keeps credentials in a temporary file with mode `0600`, removes
the file after Claude exits, and preserves the child's exit status.

The Magpie wrapper requires a private Magpie build with
`magpie-settings-helper.patch`. The patch targets Magpie v0.1.4343, commit
`2071195ff4c7076dc79820502e0f1f80378b9660`. It invokes the helper after
`agent.ClaudeLaunch` refreshes the gateway address and authentication.
The public Magpie binary does not support this integration variable.
Apply the patch to that source revision with `git apply --unidiff-zero`.

`SHEPHERDR_CLAUDE_LAUNCHERS` selects the directory containing the helper and
the private `magpie` executable. Its default is
`~/.local/share/shepherdr/claude-launchers`. The wrappers do not replace
the public Magpie executable or restart existing sessions. A public Magpie
update does not update the private build. Reapply the patch and repeat the
launcher tests when updating that build.

The Cdnd wrapper keeps its existing source of route and authentication in
`~/.zshenv`. It passes those values through the environment to the helper.
Neither wrapper writes route or authentication into the global Claude settings.

Explicit caller settings that select a different route, authentication, or
cloud provider cause an error before Claude starts. Unrelated environment
settings, proxies, certificates, hooks, and permissions remain available.
The helper accepts JSON comments, trailing commas, file arguments, inline
JSON, and both forms of `--settings`.
When callers provide multiple `--settings` flags, only the last applies, as
in Claude. The helper does not reactivate earlier hooks or permissions.

Run the fixture tests with:

```sh
python3 -m unittest discover -s test -p test_claude_launch_settings.py
```

The tests use fake Claude executables and loopback servers. They do not
prove production gateway routing or the behavior of managed Claude policy.
