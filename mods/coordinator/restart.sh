#!/usr/bin/env bash
# Restarts an agent in its own tab, optionally as another agent. The new one
# starts beside the old one (same tab labels), gets a short handoff, then the
# old one ends, so the tab keeps its name and place. A coordinator restarted
# without an argv keeps its declared launcher and reads the assistant template again.
# Its workers get herdr.coordinator=<tab> so they stay nested under the new one.
# Usage: restart.sh <old address> [argv as JSON array]
# Prints the new agent's address.
# For the chat mod (mods/chat), two optional environment variables:
#   HERDR_RESTART_CHAT=<chat pane>  the new agent starts parked behind that chat pane
#                                   (herdr.chat label) instead of getting a pane in the tab.
#   HERDR_RESTART_RESUME=1          argv resumes the same conversation: no handoff is sent.
set -u
set -o pipefail
old=$1 argv=${2:-}
# Another machine's agent (<machine>/<address>): this script runs there (its logs, templates and hc are
# that machine's), carried over hc like any cross-machine command; the new address comes back as
# <machine>/<address>, as this side names it.
if [[ "$old" == */* ]]; then
  on=${old%/*} here=${old##*/}
  envs=()
  [ -n "${HERDR_RESTART_CHAT:-}" ] && envs+=(--env "HERDR_RESTART_CHAT=$HERDR_RESTART_CHAT")
  [ -n "${HERDR_RESTART_RESUME:-}" ] && envs+=(--env "HERDR_RESTART_RESUME=1")
  # its own say on why it didn't (#980: a silent exit there read only as "It didn't restart"), kept apart from hc's
  errf=$(mktemp "${TMPDIR:-/tmp}/herdr-restart.XXXXXX")
  out=$(hc exec --on "$on" --stdin --timeout 300 ${envs[@]+"${envs[@]}"} -- bash -s "$here" "$argv" <"$0" 2>"$errf")
  code=$?
  why=$(grep -v '^[[:space:]]*$' "$errf" 2>/dev/null | tail -n 1)
  rm -f "$errf"
  new=$(tail -n 1 <<<"$out")
  if [ "$code" -ne 0 ] || [ -z "$new" ]; then
    state=$(hc machine ls --json 2>/dev/null | jq -r --arg m "${on%%/*}" '.machines[]? | select(.name == $m) | .state' 2>/dev/null)
    if [ -n "$state" ] && [ "$state" != connected ]; then echo "$on is offline. Try again once it's back." >&2
    elif [ -n "$why" ]; then echo "It didn't restart on $on: $why" >&2
    else echo "It didn't restart on $on." >&2; fi
    exit 1
  fi
  echo "$on/$new"
  exit 0
fi
agent_key() { case "$(basename "$1")" in claude-magpie|claude-cdnd) echo claude ;; *) basename "$1" ;; esac; }
agent_path='PATH="${PATH:+$PATH:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; export PATH;'
login='if [ -n "${SHELL:-}" ] && [ -f "$SHELL" ] && [ -x "$SHELL" ] && env | grep -q '"'"'^SHELL='"'"'; then exec "$SHELL" -lc '"'"'exec "$@"'"'"' herdr-login sh -c'
login_command() {
  local body=$1
  printf '%s %s "$0" "$@"; fi; %s' "$login" "$(jq -nr --arg cmd "$body" '$cmd | @sh')" "$body"
}
info=$(hc get "$old" --json) || { echo "$old isn't running here any more." >&2; exit 1; }
get() { jq -r "$1 // empty" <<<"$info"; }
[ -n "$argv" ] || argv=$(get '.labels["herdr.launcher.argv"]')
if [ -n "$argv" ]; then
  if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' <<<"$argv" >/dev/null; then
    echo "The launch command is invalid; the previous agent was kept." >&2
    exit 1
  fi
  command=$(jq -r '.[0] // empty' <<<"$argv")
  case $(basename "$command") in
    claude-magpie|claude-cdnd)
      if ! sh -c "$(login_command "$agent_path"' command -v "$1" >/dev/null 2>&1')" launcher "$command"; then
        echo "Cannot start: $(basename "$command") is not installed on this machine." >&2
        exit 127
      fi ;;
  esac
fi
space=$(get '.labels["herdr.space"]') tab=$(get '.labels["herdr.tab"]') role=$(get '.labels["herdr.role"]')
# Assistants start from the assistant template (earlier ones from "coordinator").
case $(get .template) in assistant|coordinator) role=coordinator ;; esac
cwd=$(get .cwd) app=$(get .status.app) pid=$(get .foreground.pid) created=$(get .created_ms)
chat=${HERDR_RESTART_CHAT:-$(get '.labels["herdr.chat"]')}
chat=${chat##*/}
# A coordinator placed by a tab, a chat or a chat slot proves where it lives (SHEP-70); one the service started
# without the window (#980) has only its space, and restarts in the background there.
placed=$(get '.labels["herdr.tab"] // .labels["herdr.coordinator.tab"] // .labels["herdr.chat.slot"] // .labels["herdr.chat.origin"]')
identity=""
[ -n "$space" ] || space=$(get '.labels["herdr.coordinator.space"]')
if [ "$role" = coordinator ] && [ -z "$chat" ] && [ -z "$placed" ]; then
  # #980's space alone: its space labels must agree and be this machine's, as the identity check asks of the rest.
  s1=$(get '.labels["herdr.space"]') s2=$(get '.labels["herdr.coordinator.space"]')
  if { [ -n "$s1" ] && [ -n "$s2" ] && [ "$s1" != "$s2" ]; } || [[ "$s1$s2" == */* ]]; then
    echo "conflicting or nonlocal Assistant space labels; the previous Assistant was kept." >&2
    exit 1
  fi
fi
if [ "$role" = coordinator ] && { [ -n "$chat" ] || [ -n "$placed" ]; }; then
  IFS= read -r -d '' identity_code <<'PY_IDENTITY' || :
# ---- ASSISTANT IDENTITY ----
"""Assistant identity shared by recipient lookup and the standalone restart script."""
import json
import os


class IdentityError(ValueError):
    pass


def local_id(value):
    return value if isinstance(value, str) and value and "/" not in value else None


def saved_chats():
    """Current local layout and slots only; historical backups cannot establish ownership."""
    def read(path):
        try:
            with open(path) as f:
                value = json.load(f)
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    home = os.path.expanduser("~")
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local/state")
    session = os.environ.get("HC_SESSION") or "default"
    docs = read(os.path.join(state, "herdr-core", session, "docs.json"))
    app = os.environ.get("HERDR_APP_HOME") or os.path.join(home, ".config/herdr-app")
    slots = read(os.path.join(app, "shared.json")).get("coordinator.slots") or {}
    rows = []
    if isinstance(slots, dict):
        for slot, rec in slots.items():
            if isinstance(rec, dict) and all(local_id(rec.get(k)) for k in ("space", "tab", "pane")):
                rows.append({**rec, "slot": slot})

    def visit(node, space, tab):
        if not isinstance(node, dict):
            return
        content = node.get("content") or {}
        props = content.get("props") or {}
        if content.get("mod") == "chat" and props.get("role") == "coordinator" and local_id(node.get("id")):
            rows.append({"space": space, "tab": tab, "pane": node["id"], "slot": props.get("slot")})
        for child in node.get("children") or []:
            visit(child, space, tab)

    for space in ((docs.get("herdr-app") or {}).get("value") or {}).get("spaces") or []:
        if not local_id(space.get("id")) or space.get("machine"):
            continue
        for tab in space.get("tabs") or []:
            if local_id(tab.get("id")):
                visit(tab.get("root"), space["id"], tab["id"])
    return rows


def assistant_identity(record, mappings=None):
    labels = record.get("labels") or {}
    out = {}
    for name in ("space", "tab"):
        values = {labels[k] for k in (f"herdr.coordinator.{name}", f"herdr.{name}") if labels.get(k)}
        if len(values) > 1 or any(not local_id(v) for v in values):
            raise IdentityError(f"conflicting or nonlocal Assistant {name} labels")
        out[name] = next(iter(values), None)
    if all(out.values()):
        return out
    chat = str(labels.get("herdr.chat") or "").rsplit("/", 1)[-1]
    slot = labels.get("herdr.chat.slot")
    origin = labels.get("herdr.chat.origin") or ""
    if origin.startswith("slot:"):
        if slot and slot != origin[5:]:
            raise IdentityError("conflicting Assistant slot labels")
        slot = origin[5:]
    matches = [r for r in (saved_chats() if mappings is None else mappings)
               if (chat and r.get("pane") == chat) or (slot and r.get("slot") == slot)]
    identities = {(r["space"], r["tab"]) for r in matches}
    if len(identities) != 1:
        raise IdentityError("Assistant chat mapping is ambiguous" if identities else "Assistant chat mapping is missing")
    space, tab = next(iter(identities))
    if any((out[k] and out[k] != v) for k, v in (("space", space), ("tab", tab))):
        raise IdentityError("Assistant labels disagree with its saved chat")
    if any((chat and r.get("pane") != chat) or (slot and r.get("slot") and r["slot"] != slot) for r in matches):
        raise IdentityError("Assistant chat and slot mappings disagree")
    return {"space": space, "tab": tab}
# ---- end ASSISTANT IDENTITY ----
import sys
try:
    print(json.dumps(assistant_identity(json.load(sys.stdin))))
except IdentityError as e:
    sys.exit(str(e) + "; the previous Assistant was kept.")
PY_IDENTITY
  identity=$(printf '%s' "$info" | python3 -c "$identity_code") || exit 1
  space=$(jq -r .space <<<"$identity") tab=$(jq -r .tab <<<"$identity")
fi
# A parked agent (behind a chat) has no tab labels: the chat names where it goes instead.
# A coordinator in Chat mode says where it lives in its own labels (its workers name that tab).
[ -n "$tab" ] || tab=$(get '.labels["herdr.coordinator.tab"]')
# Somewhere to start the new one: a tab, a chat, or (#980) a space alone: the service's own Assistant on a machine
# without the window (service/spaces.ts) has a space but no tab or chat, and restarts in the background there too.
if [ -z "$space" ] && [ -z "$chat" ]; then
  echo "$old has no space, tab or chat to restart into." >&2
  exit 1
fi

# What the previous agent did: its screen, and its session log when we can find it.
dir=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/coordinator/handoff
mkdir -p "$dir"
screen="$dir/$old-$(date +%s).txt"
hc read "$old" --lines 400 >"$screen" 2>/dev/null
log=""
if [ "$app" = claude-code ] && [ -n "$pid" ]; then
  # Its config folder: ~/.claude, or the CLAUDE_CONFIG_DIR it ran with (#1120: a profile, a dev container's).
  cfg="$HOME/.claude"
  if [ ! -f "$cfg/sessions/$pid.json" ]; then
    own=$({ if [ -r "/proc/$pid/environ" ]; then tr '\000' '\n' < "/proc/$pid/environ"; elif [ ! -d /proc/self ]; then ps -wwE -o command= -p "$pid" | tr ' ' '\n'; fi; } 2>/dev/null | sed -n 's/^CLAUDE_CONFIG_DIR=//p' | head -n 1)
    [ -n "$own" ] && cfg=$own
  fi
  sid=$(jq -r '.sessionId // empty' "$cfg/sessions/$pid.json" 2>/dev/null)
  [ -n "$sid" ] && log=$(find "$cfg/projects" -name "$sid.jsonl" 2>/dev/null | head -1)
fi
if [ -z "$log" ] && [ -n "$created" ]; then
  log=$(find "$HOME/.claude/projects" "$HOME/.codex/sessions" "$HOME/.pi/agent/sessions" "$HOME/.local/share/opencode" \
      -type f \( -name '*.jsonl' -o -name '*.json' \) -newermt "@$((created / 1000))" 2>/dev/null \
    | xargs -r grep -l -F "\"$cwd\"" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
fi
was=${app:-the previous agent}
handoff="You are taking over this tab from $was ($old), which was restarted."
[ -n "$log" ] && handoff+=" Its session log is $log: read the recent part to pick up where it left off."
handoff+=" Its last screen is saved in $screen."

if [ "$role" = coordinator ]; then
  workers=$( { hc ls --json | jq -r --arg c "$old" '.terminals[] | select(.parent == $c) | .address'
    hc ls --json --label "herdr.coordinator=$tab" | jq -r --arg c "$old" '.terminals[] | select(.address != $c) | .address'; } | sort -u)
  if [ -n "$workers" ]; then
    list=""
    for w in $workers; do
      list+=" $w ($(hc get "$w" --json | jq -r '.name // .labels.where // ""'))"
    done
    handoff+=" Workers the previous coordinator started, still running:$list. They report to $old: watch each with hc wait <t> and tell each to report to you from now on."
  fi
fi

if [ -n "$tab" ]; then
  labels=(--label "herdr.space=$space" --label "herdr.tab=$tab")
else
  # #980: no tab (an Assistant the service started without the window): kept in the background under its space,
  # as the service starts it, so its space's chat finds the new one
  labels=(--keep --label "herdr.space=$space")
fi
# An agent in Chat mode (parked behind a chat pane) restarts parked behind the same chat.
if [ -n "$chat" ]; then
  origin=$(get '.labels["herdr.chat.origin"]'); origin=${origin:-$old}
  labels=(--keep --label "herdr.chat=$chat" --label "herdr.chat.origin=$origin")
  slot=$(get '.labels["herdr.chat.slot"]')
  [ -n "$slot" ] && labels+=(--label "herdr.chat.slot=$slot")
fi
if [ "$role" = coordinator ]; then
  labels+=(--label herdr.role=coordinator --label "herdr.coordinator.space=$space")
  [ -n "$tab" ] && labels+=(--label "herdr.coordinator.tab=$tab")
fi
# Worker association survives even when the replacement no longer has a parent.
for k in herdr.coordinator herdr.agent; do
  v=$(get ".labels[\"$k\"]"); [ -n "$v" ] && labels+=(--label "$k=$v")
done
[ -n "$argv" ] && labels+=(--label "herdr.launcher.argv=$argv")
# The new agent never inherits a parent Claude Code session's markers the holder may carry (SHEP-86):
# the same line as core/clean-env.js CLEAN_ENV (test_repo keeps them equal).
clean='for v in $(env | sed -nE '"'"'s/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_[A-Za-z0-9_]+)=.*/\1/p'"'"' | grep -vE '"'"'^CLAUDE_CODE_(USE|SKIP|DISABLE|ENABLE|MAX|OAUTH|CLIENT|API)_'"'"'); do unset "$v"; done;'
# The role templates' folder herdr-core reads (#1182; core/paths.js TEMPLATES_SH).
case "${XDG_CONFIG_HOME:-}" in /*) tdir="${XDG_CONFIG_HOME%/}/herdr-core/templates" ;; *) tdir="$HOME/.config/herdr-core/templates" ;; esac
tpl=$tdir/assistant.md
# Without a declared launcher, use the assistant template's command.
own=""
[ -z "$argv" ] && [ "$role" = coordinator ] && own=$(awk '/^---[[:space:]]*$/ {f++; next} f == 1 && sub(/^command:[ \t]*/, "") {print; exit}' "$tpl" 2>/dev/null)
# argv's words into cmd. A read loop, not mapfile: macOS's /bin/bash is 3.2, which has no mapfile (#736).
argv_cmd() { local a; cmd=(); while IFS= read -r a; do cmd+=("$a"); done < <(jq -r '.[]' <<<"$argv"); }
if [ -n "${HERDR_RESTART_RESUME:-}" ] && [ -n "$argv" ]; then
  argv_cmd
  [ ${#cmd[@]} -gt 0 ] || exit 1
  new=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" --label "herdr.agent=$(agent_key "${cmd[0]}")" -- sh -c "$(login_command "$clean $agent_path"' exec "$@"')" herdr-clean "${cmd[@]}" | jq -r '.address // empty') || exit 1
elif [ -z "$argv" ] && [ "$role" = coordinator ] && [ -z "$own" ]; then
  new=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" assistant "$handoff" | jq -r .address) || exit 1
else
  if [ -n "$own" ]; then
    own=${own#exec }
    line=$own key=$(agent_key "${own%% *}")
  else
    argv_cmd
    [ ${#cmd[@]} -gt 0 ] || exit 1
    key=$(agent_key "${cmd[0]}")
    # Codex runs its commands outside hc without --no-daemon.
    [ "$key" = codex ] && [[ " ${cmd[*]} " != *" --no-daemon "* ]] && cmd+=(--no-daemon)
    line=$(printf '%q ' "${cmd[@]}")
  fi
  msg=$handoff
  if [ "$role" = coordinator ]; then
    body=$(awk 'f>=2 {print} /^---[[:space:]]*$/ {f++}' "$tpl") || exit 1
    msg="$body"$'\n\n'"$handoff"
  fi
  # hc delivers a template's first message once the agent is ready, so the
  # handoff goes in a one-off template, removed once it has started.
  one=herdr-handoff-$$
  file=$tdir/$one.md
  { printf -- '---\nname: %s\ndescription: A one-off Herdr handoff, removed after use.\ncommand: %s\n---\n' "$one" "$(login_command "$clean $agent_path exec $line")"
    printf '%s\n' "$msg"; } >"$file" || exit 1
  out=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" --label "herdr.agent=$key" "$one")
  code=$?
  rm -f "$file"
  [ "$code" -eq 0 ] || exit 1
  new=$(jq -r '.address // empty' <<<"$out")
  # Some agents (Codex's animated start) never settle for hc: send once it reports a status.
  if [ -n "$new" ] && [ "$(jq -r '.first_message.sent' <<<"$out")" = false ]; then
    hc wait "$new" --timeout 90 >/dev/null 2>&1
    if ! hc send "$new" "$msg" >/dev/null 2>&1; then
      echo "The handoff didn't reach the replacement; the previous Assistant was kept ($new was left for inspection)." >&2
      exit 1
    fi
  fi
fi
[ -n "$new" ] && [ "$new" != null ] && [ "$new" != "$old" ] || exit 1
if [ "$role" = coordinator ]; then
  replacement=$(hc get "$new" --json) || replacement='{}'
  if [ -z "$identity" ]; then
    # #980: a space alone, so no saved chat to prove it against: the new one must sit under that space.
    jq -e --arg space "$space" '.state == "live" and .labels["herdr.role"] == "coordinator"
      and .labels["herdr.space"] == $space and .labels["herdr.coordinator.space"] == $space' <<<"$replacement" >/dev/null || {
      echo "The replacement Assistant has no verified route; the previous Assistant was kept ($new was left for inspection)." >&2
      exit 1
    }
  else
  route=$(printf '%s' "$replacement" | python3 -c "$identity_code" 2>/dev/null) || route=''
  if [ "$route" != "$identity" ] || ! jq -e --arg space "$space" --arg tab "$tab" --arg chat "$chat" --arg origin "${origin:-}" --arg slot "${slot:-}" '
    .state == "live" and .labels["herdr.role"] == "coordinator"
    and .labels["herdr.coordinator.space"] == $space and .labels["herdr.coordinator.tab"] == $tab
    and (if $chat != "" then .labels["herdr.chat"] == $chat and .labels["herdr.chat.origin"] == $origin
           and (if $slot != "" then .labels["herdr.chat.slot"] == $slot else true end)
         else .labels["herdr.space"] == $space and .labels["herdr.tab"] == $tab end)
  ' <<<"$replacement" >/dev/null; then
    echo "The replacement Assistant has no verified route; the previous Assistant was kept ($new was left for inspection)." >&2
    exit 1
  fi
  fi
  [ -n "$tab" ] && for w in $workers; do hc label "$w" "herdr.coordinator=$tab" >/dev/null 2>&1; done
fi
hc kill "$old" >/dev/null 2>&1
hc rm "$old" >/dev/null 2>&1
echo "$new"
exit 0
