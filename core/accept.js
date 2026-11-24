// The Accept card's words and its summary, plain-words explanation and details as read: what the person approves before a Ready task merges
// (or, with nothing to merge, before it is marked done: SHEP-95).
// mods/accept-card draws it in the window, web/src/screens/Accept.tsx in the web app; both read the same words and
// the same reading of `herdr-task show --evidence` from here.
// Shared core: the source is core/accept.js; bin/sync-shared copies it into the mods in lib/COPIES. Edit it here,
// never a copy.
import { acceptAgain, nothingToMerge } from "./tasks.js";

// show --evidence includes the derived status; the saved ready state alone is not eligibility.
export const canAccept = (x) => Boolean(x?.state === "ready" && (x.status === "ready"
  || acceptAgain({ section: x.status, needs: x.needs, task: x })));

// The card's words, as the window shows them.
export const ACCEPT = {
  title: (ref) => `Accept ${ref}?`,
  reading: "Reading the task…",
  noSummary: "No summary.",
  changes: "Code changes",
  checks: "Automatic checks",
  proof: "Proof",
  artifacts: "Artifacts",
  // SHEP-89: ready's plain-words explanation leads, then what to check; the agent's own details fold below
  toCheck: "What to check",
  details: "Technical details",
  documents: "Documents",
  docNew: "New",
  docChanged: "Changed",
  docCut: "Cut short here: the rest is in the file.",
  notGit: "Not a git folder.",
  noCommits: "No commits.",
  noFiles: "· Couldn't read the files",
  noChecks: "No GitHub checks here",
  noProof: "No proof artifact.",
  open: "Open",
  opening: "Opening…",
  cancel: "Cancel",
  close: "Close",
  accept: "Accept",
  acceptMerge: "Accept and merge",
  accepting: "Accepting…",
  // SHEP-95: a task with nothing to merge (research, a design, an artifact): its card marks it done, never merges
  markTitle: (ref) => `Mark ${ref} done?`,
  markDone: "Mark done",
  marking: "Marking done…",
  noTask: "No task to accept.",
  // Send back (SHEP-87): the task goes back to its agent with the person's note, Ready to Working
  sendBack: "Send back…",
  sendBackGo: "Send back",
  sendingBack: "Sending back…",
  sendBackAsk: "What should change?",
  sendBackHint: "Its agent gets this note, fixes it and says ready again.",
  // the choices the person answered in its proof (answers.json), in Details
  choices: "Your choices",
};

// One answered choice in its proof, as Details lists it: "Ship it? Ship" (c: herdr-task's evidence.choices item).
export const choiceLine = (c) => `${String(c?.question ?? "").replace(/[:?]?\s*$/, (m) => (m.includes("?") ? "?" : ":"))} ${c?.value ?? ""}`.trim();
// Details as markdown: the agent's own details, then the answered choices under their own label ("Your choices"), a
// paragraph between so the two lists never run together.
export function detailsText(e, details) {
  const cs = Array.isArray(e?.choices) ? e.choices.filter((c) => c && c.question) : [];
  const own = String(details ?? "").trim();
  if (!cs.length) return own;
  const list = `**${ACCEPT.choices}**\n\n${cs.map((c) => `- ${choiceLine(c)}`).join("\n")}`;
  return own ? `${readable(own)}\n\n${list}` : list;
}

// The Accept button's words (SHEP-225, #1046): what pressing it will do. herdr-task's evidence says `merges` when its
// branch has work to merge (whatever the Merge setting, Accept merges that first); plain Accept when it only marks the
// task done (it worked in the folder itself, or nothing is left to merge), and while the card is still being read.
export const acceptLabel = (e, task) => (markDone(e, task) ? ACCEPT.markDone : e?.merges ? ACCEPT.acceptMerge : ACCEPT.accept);

// SHEP-95: the card of a task with nothing to merge says Mark done and leads with what it made (its proof and other
// artifacts), then the plain-words explanation. Its evidence decides once read (merges false: it worked in the folder
// itself, its branch has nothing of its own, or it isn't a git folder); until then, its task row (core/tasks.js
// nothingToMerge()), or a hint already worked out from one (true/false).
export const markDone = (e, task) => (typeof e?.merges === "boolean" ? !e.merges
  : typeof task === "boolean" ? task : Boolean(task && nothingToMerge(task)));
export const cardTitle = (ref, e, task) => (markDone(e, task) ? ACCEPT.markTitle(ref) : ACCEPT.title(ref));
export const busyLabel = (e, task) => (markDone(e, task) ? ACCEPT.marking : ACCEPT.accepting);
// What a nothing-to-merge card still shows under its lead: its changes only when it committed some, its checks only
// when there are any (a task without a pull request has none).
export const hasChanges = (e) => Boolean(e?.git !== false && (e?.commits?.count || e?.diff?.files));
export const hasChecks = (e) => Boolean(e?.checks && e.checks.state !== "none");

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "3 commits", "12 files changed", "And 4 more"
export const commitsLine = (n) => plural(n, "commit");
export const filesLine = (n) => `${plural(n, "file")} changed`;
export const moreLine = (n) => `And ${n} more`;
// A proof artifact's title without its task's ref ("HERD-4: Login works" -> "Login works").
export const proofTitle = (title) => String(title ?? "").replace(/^[A-Z]+-\d+:\s*/, "");

// Its Markdown documents (SHEP-273, #1150: a plan's or an email draft's task), each folded under its path; a task
// that changed only Markdown opens its first, as that is what the person reviews. docs = evidence.docs.
export const docOpen = (docs, i) => Boolean(docs?.only && i === 0);
// "And 2 more" under the ones shown, when it changed more than the card carries.
export const docsMore = (docs) => Math.max(0, (docs?.count ?? 0) - (docs?.list?.length ?? 0));

// Where a task no longer Ready is now, calmly: x = { state, accepted_at?, status_text? }.
export function whereNow(x) {
  if (x.state === "done") return x.accepted_at ? "Already accepted." : "Already done.";
  return `Not ready right now: it's in ${x.status_text ?? x.state}.`;
}

// { explain, toCheck }: what ready said for someone who isn't an expert (SHEP-89: --explain, in plain sentences, and
// one --check per thing to look at), which the card leads with. An older ready has neither: the card shows its summary
// first, as before.
export function simple(e) {
  const explain = String(e?.explain ?? "").trim();
  const toCheck = (Array.isArray(e?.to_check) ? e.to_check : [])
    .map((c) => String(c ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return { explain, toCheck };
}
// The explanation's paragraphs, one per line the agent wrote.
export const paragraphs = (text) => String(text ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);

// herdr-task ready's SUMMARY_MAX (as Shepherdr's): an older, longer summary shows its first sentence and folds the
// rest under Details.
export const SUMMARY_MAX = 160;

// { summary, details }: a summary written before the limit, too long to read at a glance, keeps its first sentence
// (or its first words) up top and the whole text under Details.
export function words(e) {
  const said = String(e?.summary ?? "").replace(/\s+/g, " ").trim();
  const details = String(e?.details ?? "").trim();
  if (said.length <= SUMMARY_MAX || details) return { summary: said, details };
  const head = said.slice(0, SUMMARY_MAX);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  const cut = stop >= 40 ? head.slice(0, stop + 1) : `${head.slice(0, Math.max(head.lastIndexOf(" "), 40)).trim()}…`;
  return { summary: cut, details: e.summary.trim() };
}

// Details to read, as markdown. An agent's own markdown (bullets, headings, code blocks) stays as written. Older plain
// text, one dense paragraph or plain lines, becomes short bullets: split at "; " and at sentence ends outside
// brackets, without their end punctuation, a leftover fragment of one or two words joined to the bullet before, and
// only clear paths (a folder and a file with its extension, or ~/ ./ /) as code; other file names stay plain words.
const MARKDOWN = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|```|>\s)/m;
const PATH = /(^|[\s(,;:"'])((?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\/?)(?=$|[\s),;:"'.!?])/g;
const ABBR = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|incl|[A-Za-z])\.$/i;

const codify = (s) => s.replace(PATH, (m, pre, tok) => {
  const end = tok.match(/\.+$/)?.[0] ?? "";
  const path = tok.slice(0, tok.length - end.length);
  const clear = /^(?:~|\.{1,2})?\//.test(path) || path.endsWith("/") || /\.[A-Za-z]{1,5}$/.test(path);
  return clear ? `${pre}\`${path}\`${end}` : m;
});

function sentences(line) {
  const out = [];
  let cur = "", depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    cur += c;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ";" || (/[.!?]/.test(c) && /^\s/.test(line[i + 1] ?? "") && !ABBR.test(cur)))) {
      out.push(cur);
      cur = "";
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/[;.,:]+$/, "").trim()).filter(Boolean);
}

export function readable(text) {
  const s = String(text ?? "").trim();
  if (!s || MARKDOWN.test(s)) return s;
  const items = [];
  for (const x of s.split(/\n+/).flatMap((l) => sentences(l.trim()))) {
    if (items.length && x.split(/\s+/).length < 3) items[items.length - 1] += `; ${x}`;
    else items.push(x);
  }
  return items.length < 2 ? codify(s) : items.map((x) => `- ${codify(x)}`).join("\n");
}
