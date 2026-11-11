// Shared core: the source is core/image-actions.js; bin/sync-shared copies it into mods/chat-image/core/. Edit it here.
// The image viewer's copy, open and show-in-folder (mods/chat-image, SHEP-24). The viewer draws its own copy of each
// picture (data/chat-attach/view, attach.js viewable()), so a picture whose file is gone (a finished task's worktree,
// removed since) still shows, while the buttons ran on the gone file and failed without a word: `open` and `open -R`
// exit 1 (exec resolves, the failure went unread), osascript's failure only made a toast the viewer covers. And macOS's
// copy read any file as PNG bytes («class PNGf»), so a JPEG or GIF gave the clipboard data no app can paste.
// Plain JS: no herdr, node or DOM.

/** macOS's copy (JXA, osascript): the picture at argv[0], any format NSImage reads, on the pasteboard as PNG and TIFF.
 *  argv[1]: a named pasteboard instead of the clipboard (tests). Fails (exit 1) when the file isn't a picture. */
export const MAC_COPY = `ObjC.import("AppKit");
function run(argv) {
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || img.isNil() || !img.isValid) throw new Error("not a picture macOS can read");
  const tiff = img.TIFFRepresentation;
  const png = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  const pb = argv[1] ? $.NSPasteboard.pasteboardWithName(argv[1]) : $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  if (!pb.setDataForType(png, $.NSPasteboardTypePNG)) throw new Error("the clipboard refused it");
  pb.setDataForType(tiff, $.NSPasteboardTypeTIFF);
  return "ok";
}`;

/** Which file the buttons act on: the original (`path`), or the viewer's own copy (`rel`, in the app's folder) when the
 *  original is gone. `exists(path)`: whether a file is there. { path, gone } (gone: the original isn't), or null. */
export async function target(img, appHome, exists) {
  if (!img) return null;
  const own = img.rel ? `${appHome}/${img.rel}` : null;
  if (img.path && await exists(img.path)) return { path: img.path, gone: false };
  if (own && await exists(own)) return { path: own, gone: Boolean(img.path) };
  return { path: null, gone: true };
}

/** The command for an action ("copy", "open", "reveal") on a file: [program, args]. os: window().platform. */
export function command(action, os, p) {
  if (action === "copy") {
    if (os === "macos") return ["osascript", ["-l", "JavaScript", "-e", MAC_COPY, p]];
    if (os === "windows") return ["powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetImage([Drawing.Image]::FromFile($args[0]))", p]];
    // wl-copy stays behind to serve the clipboard: its output must not hold exec open.
    return ["sh", ["-c", 'if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null; then wl-copy < "$1" >/dev/null 2>&1; else xclip -selection clipboard -t "$(file -b --mime-type "$1")" -i "$1" >/dev/null 2>&1; fi', "copy", p]];
  }
  if (action === "open") {
    if (os === "macos") return ["open", [p]];
    if (os === "windows") return ["cmd", ["/c", "start", "", p]];
    return ["xdg-open", [p]];
  }
  if (os === "macos") return ["open", ["-R", p]];
  // explorer's exit code is 1 even when it worked: never read as a failure (failed()).
  if (os === "windows") return ["explorer", [`/select,${p}`]];
  return ["sh", ["-c", 'dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:"file://$1" string:"" >/dev/null 2>&1 || xdg-open "$(dirname "$1")"', "reveal", p]];
}

/** Whether an exec result (null: it couldn't start) means the action failed. */
export function failed(action, os, r) {
  if (!r) return true;
  if (action === "reveal" && os === "windows") return false;
  return r.code !== 0;
}

const TITLES = { copy: "Couldn't copy the image", open: "Couldn't open the image", reveal: "Couldn't show the image in its folder" };

/** What the viewer says when an action can't run or fails: { title, body } (body "" for none). t: target(); r: the
 *  exec result, null when it couldn't start, undefined when it never ran. */
export function problem(action, t, r) {
  const title = TITLES[action];
  if (!t?.path) return { title, body: "The file is gone." };
  if (action === "reveal" && t.gone) return { title, body: "Its folder is gone (a finished task's worktree is removed)." };
  const line = String(r?.stderr ?? "").trim().split("\n").pop()?.replace(/^.*execution error: (Error: )*/, "").replace(/ \(-?\d+\)$/, "") ?? "";
  return { title, body: r === null ? "The command it needs isn't installed." : line };
}
