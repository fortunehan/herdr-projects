// A file as a read-only code tab (SHEP-31), opened from Files (mods/files-tasks, lib/code-tabs.js).
// Props {root, file, on}: the folder, the file's path in it and its machine (null: this computer). The tab is saved
// with its pane, so after a restart the file is read again; one that has gone says so.
import { View, div } from "gpui-kit";
import { v_flex, Editor, EditorState } from "gpui-base";
import { props, readTextFile, theme, settings } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MAX_CHARS = 400000;

function language(file) {
  const name = String(file ?? "").split("/").pop();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
  return LANG[ext] ?? ext;
}

export default class CodeView extends View {
  init(_props, cx) {
    this.code = null; this.message = "Loading file…";
    this.load(cx);
  }

  load(cx) {
    const { root, file, on } = props() ?? {};
    if (!root || !file) { this.message = "No file to show"; return; }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${file}`, { on: on ?? null });
        if (text === null) this.message = `${file} is no longer there`;
        else if (text.includes("\0")) this.message = "Binary file · no text preview";
        else {
          const t = theme();
          this.code = EditorState.new({ language: language(file), readonly: true,
            value: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n… (file truncated)" : text,
            font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        }
      } catch { this.message = "Cannot show this file (binary, larger than 1 MiB, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  close() {
    this.code?.release(); this.code = null;
  }

  render() {
    const t = theme();
    return v_flex().id("code-view").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(16).text_color(t.dim).child(this.message));
  }
}
