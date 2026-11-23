# Working on Shepherdr

How to run, build and lay out the code: [docs/develop.md](docs/develop.md).

## Tests

- Quick checks are fine here (seconds): `bin/sync-shared --check`, `python3 -m unittest discover -s test` and the
  `node --check` loop in [docs/develop.md](docs/develop.md). The installer tests use throwaway roots only.
- Shell checks: plain `bash -n` is the real one. Dash (`sh -n` here) misses bash-only parse errors that macOS's bash 3.2
  hits, so run `bash -n` on every script.
- Installer tests run from `test/`: `cd test && python3 -m unittest test_install`. To run an older installer copy for a
  before-check, export `SHEPHERDR_HANDED_OVER=1` (else it hands over to the source's `bin/shepherdr`), and use a full
  `git archive` of the tree, since `herdr_task` lives beside `bin/`.
- herdr-browser's library check: `test/test_herdr_browser_libs.py` fakes ldd and agent-browser; a real missing-library
  Chrome needs gcc, linking a library built with `-Wl,-soname` and then deleted.
- herdr-browser's AppArmor case: test with `HERDR_BROWSER_USERNS_SYSCTL` and `HERDR_BROWSER_APPARMOR_D` stand-ins; a real
  refusal: `sudo sysctl user.max_user_namespaces=0`, then restore the old value.
- Read-only sandbox check: `chmod 555` a scratch dir, run herdr-task with `HERDR_TASK_STORE=<dir>`; a read must not
  need the lock file to be writable.
- Never run herdr-app or herdr-task with a changed `HOME` or `HERDR_APP_HOME`, never start a second herdr-app window,
  and never install into the real `~/.config/herdr-app` for a try: use `./install.sh --root <scratch>`. A window or
  scheduler on another home can overwrite every machine's spaces.
- `herdr-app check <mod folder>` runs a mod's `init()` for real: never for `shepherdr-settings` (its init pushes
  settings to other machines), nor for `tabs-tasks` (its init starts the service and bridge for real).
- Window-mod methods (e.g. chat's `refocus()`) can be tested by extracting the method text from `mods/chat/main.js`
  and running it in node with stubs (see `test/test_chat_refocus.py`).
- `herdr-app check` never runs a v_virtual_list's rows: window-mod list rows must take no handlers (on_*) and no kept
  cx (gpui-kit.d.ts 'no handlers and no retained state'); service/chat-rows.test.ts runs the chat's list renderer as written.
- Window chat `rows()` can be run in a bun test with stubs: status, resolveArts, newsLines, loadAskEnds, workerTasks,
  timelineCards plus conv/replied/pending/queue/tr fields (see service/chat-paths.test.ts); the chat's log page caps at
  ~258 items whatever record count the SHEP-109 render harness asks for.
- Window-mod render cost in QuickJS: `herdr-app check` on a scratch /tmp mod folder (main.js + copied core files) runs
  the window's own engine; its render is interrupted past ~50 ms, and matchAll there recompiles the pattern on every call.
- Window markdown can't use marked; to check a markdown rewriter, compare marked.lexer code/link tokens before and
  after (see core/chat-links.test.js 'code blocks read the same to marked').
- Mark up (`mods/artifacts/markup.js`) imports must be listed in `MARKUP_HELPERS` in `mods/artifacts/bin/herdr-artifact`
  so each published artifact carries them; `test_every_installed_import_resolves` checks the imports.
- Header layout checks: the web app keeps its pinned-lists and sidebar state across page loads, so a stub page can
  start with leftovers; set localStorage then reload, or use a new port. Never `pkill -f` a stub: it matches your own
  shell.
- GitHub runs the whole check on every pull request to main and after each merge: the Check workflow
  (`.github/workflows/check.yml`). Merging waits for it. A failure's log is `gh run view <run> --log-failed`.
- Still write tests with your change: the installer's in `test/test_install.py`, the repo's rules in
  `test/test_repo.py`, herdr-task's in `test/test_herdr_task.py`. herdr-task's can use a real throwaway git repo
  (tempfile) for git logic and mock only hc and gh.
- On a dev Mac about 34 `test_herdr_task` tests fail at `git commit` because they inherit the global git config (hooks,
  signing): compare the failure list before and after a change, or set `GIT_CONFIG_GLOBAL=/dev/null` as
  `test/test_local.py` does. Main's list without a second worktree: `git archive main` into a fresh `mktemp -d` folder (the
  dev Mac's command guard refuses recursive deletes of a fixed /tmp one), run unittest with that folder as the cwd (os.chdir, e.g. runpy: home_guard
  resolves relative paths against the cwd, and a cwd under ~/.herdr fails 200+ tests) and diff the FAIL lines.
  That folder has no node_modules, so test_chat_refocus, test_open_vscode, test_task_shell and test_thread_space also
  fail there: compare only the branch's extra FAIL lines.
- Even with `GIT_CONFIG_GLOBAL=/dev/null`, 8 `test_herdr_task` Automation/AssistantSettings tests fail on main on the
  dev Mac, and `core/bg-jobs.test.js` 'JOBS sees the output file...' fails there too (/var vs /private/var tempdir).
- On the dev Mac, `service/spaces-sidebar.test.ts`'s grace-period test fails when `service/emoji-pick.test.ts` runs first in
  the same bun process (`bun test service`); it passes alone, on Linux CI and on pure upstream.
- Node tests from `test/` are slow on the dev Mac (~12 s per first node call): home_guard's throwaway HOME makes the
  mise node shim slow. Not a hang. If it does hang (the shim tries to download node under the throwaway HOME), run
  them with `PATH="$(dirname $(mise which node)):$PATH"`.
- On the dev Mac a node/python call with a whole task record (its long prompt) in argv can be SIGKILLed (exit 137) by
  the command guard: pass a trimmed record or a file.
- herdr-task as a real subprocess in tests (fake hc and `HERDR_TASK_GH` on PATH): boot it with `-c` and set
  `base.not_real = lambda: None`, as `SlowCallsOutsideTheLock` does.
- In test_ado.py install the fake ADO transport in setUp, before any accept/own_open_pr call: a test that runs
  cmd_accept before `self.fake(...)` sends a real request to dev.azure.com.
- herdr-task against a slow fake Azure DevOps in real processes: a `PYTHONPATH` dir with `sitecustomize.py` that imports
  `herdr_task.ado` (BIN on `sys.path`) and replaces `ado._request`, a scratch `HERDR_TASK_STORE` and `HERDR_TASK_ADO`, a fake
  hc on PATH and the real HOME; the `--worker` child inherits it.
- The dev Mac's global commit-msg hook requires Conventional Commits (`type(scope): description`, e.g.
  `fix(chat): SHEP-7 ...`).
- Logic in `lib/*.js` can be bun-tested from `core/*.test.js` (CI runs `bun test service core web`, not `lib`). Never
  `mock.module('herdr')` there: Bun keeps it for the whole run and breaks later files importing herdr; load the lib
  file's source with stubs via `new Function` instead.
- herdr-task code that launches agents is tested with SimpleNamespace stores lacking `.loc` (test_review_launch,
  CleanEnv): don't read `s.loc` unconditionally in launch().
- One test file: `python3 -m unittest discover -s test -p test_ado.py` (add `-k <Class>`).
- A bare remote for herdr-task git tests: `init --bare` in the tempdir, `remote add origin`, push main; see
  `test_herdr_task.StackedTasks`.
- `docs/**` is in the dev Mac's global gitignore: a new docs/ page needs `git add -f`.
- The dev Mac's command guard (dcg) also blocks heredoc-fed edits (`python3 - <<EOF`, `cat > f <<EOF`): write the script
  to /tmp with your editor tool and run `python3 /tmp/x.py`.
- Reproduce a Codex worker's sandbox on a Mac: `CODEX_HOME=<scratch>` with a `[permissions.<name>]` profile (filesystem +
  `network.enabled`) and `codex sandbox -P <name> -C <dir> -- <cmd>`; `hc exec` ends processes carrying HC_SCOPE when
  the command ends.
- Window-mod dialog keyboard tests: `service/settings-keys.test.ts` runs Shepherdr Settings' real init()/close() with
  fake-herdr and a Proxy InputState. In zsh, pass a list of unittest ids as `${=ids}` (zsh doesn't word-split `$ids`).
- Before-check of a mods/chat service test: `git archive main` into a `mktemp -d` folder, symlink the worktree's
  node_modules, copy the test into its service/ and run `bun test` there.
- On a busy dev Mac, Bun tests can pass the default 5 s timeout: rerun the failed files with `bun test --timeout 60000`.
- A quick before/after of herdr-task settings logic without a second worktree: a `python3 -I` script that puts each tree's
  `mods/tasks/bin` on `sys.path`, sets `HERDR_TASK_SETTINGS` to a scratch file and stubs `herdr_task.autopilot.window_spaces`.

- Upstream sync after a squash-merged sync: re-merge each conflicted file with `git merge-file` using the last synced
  upstream tag as base (`--diff-algorithm=histogram` for test_herdr_task.py); upstream's node-harness tests need the fork's names stubbed.

## Trying a change

- A fresh worktree: `bun install && bun web/build-plugins.ts` before `bunx tsc` or a build (else missing types and
  `web/generated`).
- A branch's web app on the machine that serves it: build it (`bun run build`), then send `bin/shepherdr`'s
  `pack(<worktree>)` to `INSTALL_THERE` over `hc exec --on <machine> --stdin` (what `cmd_web_install_on` does from
  the installed copy). Browser pages can't use the local service on 127.0.0.1.
- `herdr-browser screenshot` takes an absolute path (a relative one lands in the repo). Headless agent-browser has no
  hover: restart its session with
  `--args "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"`.
- Claude Code may log an agent's message only as a thinking block: replay a real log through `core/chat-log.js`
  before blaming the reader.
- A branch's web app with live data, the installed one untouched: `vite preview` of its build behind
  `tailscale serve --set-path`, proxying `/api` (changeOrigin, origin header) to the serving machine's `/shepherdr`
  (`shepherdr web status` says which). Put the Mac mini back on the release the same way from
  `~/.local/share/shepherdr`.
- A test space's Assistant without the window: `hc run` it with the chat slot labels from the newest
  `data/backups/*/sidebar.json` (`coordinator.slots`), as `service/actions.ts` does; answer the folder-trust prompt
  with `hc keys <t> down enter`.
- No Shepherdr service runs on the dev VM: to screenshot a web dialog, serve `web/dist` with a tiny Bun stub answering
  only the APIs it needs, never the full service: upgrade `/api/ws` and send
  `{type:'snapshot',snapshot:{places,machines,tasks,...}}`; 404 other `/api`. A later pushed `chat` event (setTimeout) makes
  replies arrive while scrolled up (the Latest pill's count). Run the stub in the background, or it dies with the shell call. Each
  place in the snapshot needs a `chat` field (else a blank crash); open a viewer with `?artifact=<id>`, a task with
  `?task=<id>`. Answer the client's `watch` message with `{type:'chat',chat}` per key; `sections: []` lists places
  under their machine in the sidebar. A stub chat message can carry any Message field (brief, activity, news) to
  screenshot quiet rows without a real log. For a before/after of task rows without rebuilding twice, import main's
  `core/tasks.js` (`git show main:core/tasks.js`, plus `needs.js` and `asks.js`) in the stub and compute each row's
  sub line with `place()` and `secondLine()`. For whole rendered rows, build main's dist in a git-archive copy with
  node_modules symlinked from the worktree, and make each stub's snapshot with that tree's own `service/compat.ts`
  `Compat().snapshot({host,user,machines,spaces,sections,rows})`, rows placed by that tree's `core/tasks.js`.
- Two throwaway cores on one VM: `herdr-task --on <it>` installs its bundle into the real `~/.local/bin/herdr-task` unless
  `$HERDR_TASK_STORE/.remote/<machine>` already says `source`; write that first.
- A cross-machine send without ssh: two throwaway cores (`HC_SESSION=a`/`b`, clean `env -i`) and
  `hc machine add --via 'sh -c' --name vmb --session b` on a; the wrap only shows with a real agent (e.g.
  `claude --model haiku`) as the target.
- Web dictation on the dev VM: agent-browser's fake-mic flags don't apply; override
  `navigator.mediaDevices.getUserMedia` with an oscillator `MediaStreamDestination` via eval.
- Headless image-clipboard proof on the dev Mac: agent-browser denies clipboard-read and its Meta+v fires no paste; run
  Google Chrome `--headless=new` with its own `--user-data-dir` and CDP, `Browser.grantPermissions` clipboardReadWrite for
  the origin, click via `Input.dispatchMouseEvent`, then read `navigator.clipboard`.
- Headless clipboard checks: agent-browser's `clipboard read` is blocked; focus a textarea and `press Control+v` to
  read what was copied. Phone long-press: CDP `Emulation.setTouchEmulationEnabled` + `Input.dispatchTouchEvent`.
- Another machine in herdr-task tests: run herdr-task as a subprocess with `HERDR_TASK_STORE=<tmp>` and a fake hc first on
  PATH (see AutomationFromAnotherMachine).
- On the dev Mac `~/.local/bin/gh` is a wrapper that hard-codes `HTTPS_PROXY=127.0.0.1:10060`: set
  `HERDR_TASK_GH=/opt/homebrew/bin/gh` to test proxy behaviour for real.
- Python tests: each `test/test_*.py` imports `home_guard` first (a throwaway HOME for the run; touching the real home
  fails the test). Run them with `discover -s test` or from `test/`; one class from `test/` with
  `cd test && python3 -m unittest test_herdr_task.ClassName` (from the repo root the module import fails).
- herdr-task tests that need a real task list on disk plus a faked `begin()`: reuse Scheduled's setUp/run_cmd/tick_at as class
  attributes (see DoubleStart) instead of subclassing, which reruns Scheduled's tests.
- Before-checks against main: `git archive origin/main | tar -x -C <scratch>`, copy the branch's new tests in, run there
  (installer: `SHEPHERDR_HANDED_OVER=1`; a git worktree of main fails, it's checked out in ~/dev/shepherdr). Patch new names
  with `mock.patch.object(..., create=True)` so the same test runs on both.
- Tests that run accept or merge with the real `finish()` must stub `github.live_agents` and `live_helpers` (hc is
  refused under test).
- Bun.spawn ignores a PATH changed inside a test: point the service at fakes with `SHEPHERDR_HERDR_APP` / `SHEPHERDR_HC`.
- Bun's `mock.module` does not rebind names a mod already imported: `service/fake-herdr.ts` forwards every name to the last
  stand-in, so test files with different herdr data can share one process.
- `bun test` from service/ alone skips bunfig's preload (2 false failures): run `bun test service core web` from the repo root.
- Window-mod methods that need `cx.spawn`'s result in a bun test: give the stub cx a spawn that keeps the promise (see the
  #1010 tests in service/spaces-sidebar.test.ts). ShepherdrSettings menus go through `mods/shepherdr-settings/over.js`.
- Window-mod render tests: `bun test` in service/ with `mock.module` for gpui-kit/gpui-base and herdr via
  service/fake-herdr.ts (bun's mocks are per process, so every herdr stand-in needs every name); see
  service/spaces-sidebar.test.ts.
- The window's `fs/promises` has only exists, mkdir, readFile, readdir, rmdir, unlink and writeFile (no stat): bun's fs
  has more, so a mod test can pass while the window throws; `service/picture-viewer-actions.test.ts` checks every mod's
  `fs.<name>`.
- macOS 26 (the dev Mac) has no `/usr/bin/test`, only `/bin/test`, and herdr's `exec` rejects a missing absolute
  program path: use `/bin/test` (or a plain name) in window mods.
- No herdr-app window runs on the dev VM: window-mod UI can only be syntax-checked here, not screenshot. No ImageMagick
  either: crop proof screenshots with python3 PIL. Stop a background stub with `kill $(lsof -t -i:<port>)`, never
  `pkill -f` on its path (it matches the calling shell).
- Autopilot wake replay: print `herdr_task.autopilot.message()` (patch `heartbeat_of`/`direction_of`), then
  `claude -p --append-system-prompt templates/assistant.md` in a scratch repo with fake herdr-task/hc on PATH.
- Web stub screenshots: a Place needs id, name, machine, level, status and chat (key); a stub Message uses
  `who: 'you'|'agent'`; rebuild web/dist (`cd web && bunx vite build`) after each web edit before re-screenshotting.
- On the dev Mac there's no PIL either: crop proof screenshots with `herdr-artifact crop --rect` (`sips -c H W
  --cropOffset Y X file` can give a blank crop on a same-width image). `diff` is a
  shell alias there: use `/usr/bin/diff`.
- Web stub: a place's `chat` is its chat key string (the chat object goes only in the watch reply). Headless screenshots
  never show native `title=` tooltips: check with `document.querySelectorAll('[title]')`.
- A web stub for artifact Mark up: `/api/action` POST logs the act, `/api/artifacts/<id>/recipe` returns the recipe;
  agent-browser `mouse move/down/up` drives clicks and drags on the layer. `herdr-artifact preview` takes no `--folder`.
- `herdr-artifact preview` with a branch's viewer: copy mods/artifacts into a scratch folder with `web/dist/artifact-viewer.html`
  beside it as viewer.html, and run that copy with `HOME=<scratch>` so it uses a throwaway store.
- The web app's page-filling full screen in agent-browser: eval
  `Object.defineProperty(Document.prototype,'fullscreenEnabled',{get:()=>false,configurable:true})` before clicking
  Full screen. Tailwind's `@container` (container-type) traps `position:fixed` descendants.
- Translation proofs: a stub OpenAI-compatible endpoint on 127.0.0.1 driving service/translate.ts Translator from a Bun
  stub; translation keys need 16 ASCII letters and digits, so give the stub a long fake key.
- `herdr-artifact preview` of a real artifact with a branch's viewer: a scratch HOME needs the store record renamed to
  the folder's slug outside HOME (`Users-<user>-<path>.json`) plus `files/<id>`; the preview viewer takes `?full=1`
  for the full-screen layout.
- Web tests that render screens/Recipe.tsx need kernel.ts page globals and mock.module of web/plugins/chat/markdown.tsx
  (DOMPurify needs a DOM): see web/plugins/artifacts/spots.test.tsx.
- Mark up messages end to end: run service/actions.ts act() with a real Artifacts instance and HERDR_APP_HOME pointing
  at a scratch mods/artifacts/bin/herdr-artifact wrapper that loads the branch CLI with STORE patched and run()
  capturing hc send.
- agent-browser's mouse wheel always lands at the page's top left (whatever mouse move said): test a wheel handler
  with a dispatched WheelEvent, and scroll by setting scrollTop for screenshots.
- Viewer CSS: `web/src/styles.css` must list `./screens` (`@source`) or the artifact viewer build drops `Recipe.tsx`
  classes such as `@lg:`.
- Before/after web screenshots: build main's version of the changed files into a scratch dist (`git checkout main --
  <files>`, `bun run build`, copy `web/dist`, `git checkout HEAD -- web`) and run one stub per dist on different ports.
- Real Codex in a throwaway hc session: `env -i HOME PATH TERM HC_SESSION=x CODEX_HOME=<scratch with auth.json symlinked> hc run --bg ...`;
  herdr-task's own code refuses hc under a changed HC_SESSION, so feed it saved `hc ls`/`hc get` JSON instead.
- Crash recovery for real: a throwaway core, `HC_SESSION=<name> hc ...` with `HC_TERMINAL_SOCKET` and Claude's
  `CLAUDE_*` env unset (`CLAUDE_CODE_CHILD_SESSION` turns off transcripts).
- Service code against a throwaway core (`HC_SESSION=x`): Hub ignores `HC_SESSION`, so pass `new Hub(<wrapper script
  that exports HC_SESSION and execs hc>)` and set `SHEPHERDR_HC` to it; start that core from `env -i` or its agents
  inherit `CLAUDE_CODE_CHILD_SESSION` (no transcripts).
- A real `herdr-task switch` test without touching people's tasks: a fake hc on PATH exporting `HC_SESSION=<name>`,
  `HERDR_TASK_STORE=<tmp>`, a scratch git repo with `add --here` and `start --space <any>`; answer the trust prompt with
  `hc keys <t> down enter`. Claude refuses a plain sleep, so give the brief a busy step.
- React render counts with agent-browser: relaunch the session with `--enable react-devtools` (close, then
  `--enable react-devtools open URL`) and build with `vite --minify false` to get component names.
- Web stub: localStorage `shepherdr.lists` = `{pinned:true,chips:[],at:null}` opens `?task=<id>` in the middle column
  (same width as the Assistant's) instead of the side.

## Other machines

- `herdr-task --on <machine>` copies its bundle there, and a hub (the Mac mini) copies it on: running a branch's
  herdr-task against other machines spreads that branch fleet-wide until the next update. Prefer local tests.
- herdr-task's scheduler re-execs itself within 15 s when its code changes. Its live code is either the zipapp
  `mods/tasks/bin/herdr-task` or the `herdr_task/` folder beside it (`zipfile.is_zipfile` says which).
- Reach map tests: `test/test_reach.py` puts logging fake ssh/tailscale/hc on PATH and runs the real probe; reuse it for
  anything that might contact other hosts.

## Add-ons

- Window mods, `keys.json` sections, layouts and app commands (`tab.close`, `pane.close`, `focused()`...): Herdr's own
  reference is `~/.config/herdr-app/AGENTS.md` and `~/.config/herdr-app/herdr.d.ts` (written by the app on each start;
  read the parts you need, never edit them).
- `lib/addons.json` lists every mod by add-on; a new mod goes in one (the tests check). Shared modules have one
  source in `lib/`: edit it, run `bin/sync-shared`. A worktree's `lib/.last` can be stale (copied from the main checkout): if
  sync-shared calls a copy hand-edited though it equals HEAD's lib file, refresh `lib/.last/<file>` from `git show HEAD:lib/<file>` (and `lib/.last/core/<file>` from `git show HEAD:core/<file>`). On the dev Mac the command guard (dcg) blocks a shell redirect onto a home or `$VAR` path: write to a literal /tmp path and `cp -f`, use python's open(), or extract one file with git archive piped to tar. The add-ons' switches and how they work: [docs/addons.md](docs/addons.md).
- Mod names, the layout's node ids and `keys.json` contexts are what people's state and keys hang on: change them
  with care and say so in your done summary.

## After a task is accepted

- Only the space's Assistant (coordinator) does this, on a task's `done` news; task workers never do. In the main
  checkout: `git fetch`, `git merge --no-edit origin/main` (a merge commit, never a rebase), then `./install.sh --yes`
  on this machine only. Report the installed version. Stop and ask on a merge conflict. Never push, and never install
  on another machine.
- When Settings > Machines > Update after a Shepherdr task merges is on for this machine, herdr-task does these steps
  itself a few minutes after the merge ([docs/self-update.md](docs/self-update.md)). Skip them once its
  `self-update` news says it updated, and only pass on the version. If it says it stopped, tell the person and follow
  its finish-by-hand command once they say yes. `herdr-task self-update` shows how the last update ended.

## README

- `README.md` is the project's landing page, and its design is the human's. Never change its design, layout, structure,
  hero or length, in a release or any other task, without the human's explicit yes.
- Only fix facts that became false, in place, in the same voice. Detailed docs go in `docs/`, not the README.
- "The previous README" means the one on main just before (`git log main -- README.md`), never a tag's.

## Releases

- Never cut a new release (version bump, tag, GitHub release, publish) without asking the human first and getting a
  yes.
- Version bumps are patch only (2.0.0 → 2.0.1) unless the human explicitly asks for a minor or major one.
- From SHEP-238: headless Chrome with flags herdr-browser ignores (e.g. --autoplay-policy=no-user-gesture-required, fake mic): run ~/.agent-browser/browsers/chrome-*/chrome --headless=new --user-data-dir=<scratch> --screenshot/--dump-dom directly.
- From SHEP-240: a second visible browser page on the dev VM: run ~/.agent-browser/browsers/chrome-*/chrome --headless=new --remote-debugging-port=<p> <url> in the background and screenshot over CDP (Page.captureScreenshot); herdr-browser's --headers don't reach WebSockets.
