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
