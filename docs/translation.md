# Translate

A Translate button on agents' messages, proofs and artifacts shows a translation under each paragraph, list item,
heading, quote, table cell and artifact text block, like the Immersive Translate browser extension. The original stays;
the translation sits under it, a step dimmer with a thin rule on its left. Press the button again to hide it.

- **Where:** the Herdr window's chat (Assistant and task chats: the icon in a message's band, beside Fork), the web
  app's chat (the same icon; on a phone, Translate in the message's hold menu), and the artifact viewer's and sidebar's
  bars (one button for the whole version).
- **What:** the agent's messages, once complete (no button while it still writes one, nor in a phone's hold menu),
  proofs and recipe artifacts (their text blocks, captions, table cells, a tab's label and a chart's legend; a bar or
  line chart's axis labels stay as they are).
  Never your own messages or question cards. Code blocks, inline code, commands, paths, task ids (SHEP-96) and links
  stay as they are and get no translation line.
- **Direction:** decided on this machine with no model call (`core/translate.js direction`): code and links taken out,
  CJK over ~30% of the letters is Chinese and goes to English; anything else goes to Chinese.

## Settings › Translation

One page for every space (Everywhere's `translation` in Shepherdr's settings file):

| Row | Kept as | What it is |
| --- | --- | --- |
| Translate button | `on` | Off by default. The first time it is turned on, the page says that the words you translate are sent to the endpoint (`agreed` keeps when). |
| Endpoint (base URL) | `base_url` | An OpenAI-compatible API, e.g. `https://api.openai.com/v1`; `/chat/completions` is added. |
| Model | `model` | The model that translates, as the endpoint names it. |
| API key | `key` | The name of a secret in Settings › Secrets (Everywhere), picked from that list (never typed). Its value is read into memory only, never shown or logged. |
| Test connection | | Sends "Hello" and shows what came back. |

Only the endpoint set here is ever called. There is no built-in public service.

## How it works

- The local Shepherdr service makes every request (`service/translate.ts`, the `translate` action on `/api/action`),
  with this machine's key, also for chats from other machines: the window and the web app send it the message's words.
  An artifact is read by the service itself (`{ artifact, v, on }`).
- The key is found as a voice call finds its own: the vault here when this machine keeps the secrets, else read from
  the machine that does over herdr-core's link, into memory only (kept there 10 minutes).
- The message is split into blocks (`mdBlocks`), and every block with words goes in ONE request asking for a JSON array
  of the same length and order (`requestBody`, `parseTranslations`). An answer of another length or shape is asked
  again block by block (a one-block message once more); a refused key or a missing model fails at once. Each answer is
  made inert (`inert`): no pictures or HTML, and a link only to an address the original names.
- A refusal of the key shows as a fixed line; any other error of the endpoint has the key taken out before it is cut
  short, so no piece of it can reach a chat.
- The web app finds the same blocks in the rendered page (h1-h6, p, li, th/td, in reading order) and puts each
  translation under its block; if the page's blocks don't match, the translations go under the whole message instead.
  The window draws the message block by block with each translation under it (a nested item as deep as it was), its
  code blocks as before (Copy and all), and a table as cells, each cell's translation inside it.
- The window's artifacts are drawn by a copy of the recipe view inside each installed artifact; a change to that view
  (or `recipe.js`, `translate.js`) reinstalls them, so an artifact installed before still shows its Translate lines.
- Translations are kept on the serving machine (the service's folder, `translations/`): one per message text (or
  artifact version and its words) and target language, shared by the window, the web app and the phone. Pressed
  again, only the blocks that failed are sent.
- A failure is one short line under the message (or the block) with Retry; no pop-up.
- Manual only: there is no switch to translate a whole chat by itself.

## Tests

`core/translate.test.js` (blocks, the page's blocks as marked renders them, direction, the request and its answer,
the per-block fallback, recipes, settings, the key) and `service/translate.test.ts` (a stub endpoint on 127.0.0.1:
one request, the cache, the fallback, a refused key, Test connection, Settings › Translation's rows).
