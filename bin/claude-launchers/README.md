# Claude launchers

## claude-mgp (public Magpie, no patch)

Herdr appends its own `--settings` (fastMode, statusLine, card hook) to the
agent command. Claude honours only the last `--settings`, and
`magpie claude run` starts `claude --settings <magpie file> <caller args>`, so
Herdr's flag would replace the file holding Magpie's route and authentication.

`claude-mgp` fixes this with the public Magpie binary:

1. It resolves the real `claude` with `command -v` before touching `PATH` and
   exports it as `SHEPHERDR_CLAUDE_REAL`.
2. It puts `claude-mgp-shim/` first on `PATH` and runs `magpie claude run "$@"`.
   Magpie refreshes the gateway address and authentication, then starts the
   shim as `claude`.
3. The shim calls `shepherdr-claude-settings magpie --base <Magpie's file> --
   <real claude> <caller args>`. The helper merges Magpie's route with the
   caller's `--settings` into one private `0600` file, removes it after Claude
   exits and keeps the child's exit status.

The shim fails with a clear message and a non-zero status when its arguments
do not start with `--settings <file>`, when the real Claude is missing, or when
`claude` resolves to the shim itself.

`SHEPHERDR_MAGPIE` names another Magpie executable (default: `magpie` on
`PATH`). `SHEPHERDR_CLAUDE_LAUNCHERS` is the folder holding
`shepherdr-claude-settings` (default `~/.local/share/shepherdr/claude-launchers`).
Install `claude-mgp`, `claude-mgp-shim/` and the helper together; `claude-mgp`
finds the shim beside itself, following symlinks.

### Magpie behaviours it relies on

- `magpie claude run` finds `claude` through `PATH`.
- It starts that `claude` with `--settings <path>` as the first two arguments.

After a Magpie update, check both with a fake `claude` first on `PATH`:

```sh
d=$(mktemp -d); printf '#!/bin/sh\nprintf "%%s\\n" "$@"\n' > "$d/claude"; chmod +x "$d/claude"
PATH="$d:$PATH" magpie claude run --probe
```

The first printed line must be `--settings`, the second a file path, then
`--probe`. The test suite exercises the same contract with a fake Magpie.

Magpie's own settings file is mode `0644` and holds its authentication. That is
Magpie's behaviour, not this launcher's: the merged file the helper writes is
`0600`.

## claude-cdnd

Cdnd's route is process environment. `claude-cdnd` reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from
`~/.config/shepherdr/claude-cdnd.env` (override: `CLAUDE_CDND_ENV`; keep it
mode `0600`), exports them and runs `claude` directly. A `--settings` flag
without `env` cannot override process environment, so no helper is involved.
A missing file or variable is an error (exit 1). Values are never printed.

## Helper rules

Explicit caller settings that select a different route, authentication, or
cloud provider cause an error before Claude starts. Unrelated environment
settings, proxies, certificates, hooks, and permissions remain available.
The helper accepts JSON comments, trailing commas, file arguments, inline
JSON, and both forms of `--settings`. When callers provide multiple
`--settings` flags, only the last applies, as in Claude.

Run the fixture tests with:

```sh
python3 -m unittest discover -s test -p test_claude_launch_settings.py
```

They use fake Claude and Magpie executables and loopback servers. They do not
prove production gateway routing or the behavior of managed Claude policy.
