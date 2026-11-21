// Agents > Output language (SHEP-101, herdr-task's settings.language_line): the language Assistants and task agents
// write to the person in. "" follows the person (the language of the last message they typed); a language names one
// for every agent in this scope. Its choices sit under the row's words: five don't fit beside them.

import { shepherdrFor } from "./coordinator.js";
import { segmented } from "./ui.js";
import { LANGUAGE, languageChoices } from "./core/settings.js";

export function languageRow(view, t) {
  const now = String(shepherdrFor(view.cfg, view.scope).agents.language ?? "");
  return view.row(t, LANGUAGE.title, LANGUAGE.about, null, view.scoped("agents", "language"),
    segmented("language", languageChoices(now), now, (v, _e, cx) => view.set("agents", "language", v, cx)));
}
