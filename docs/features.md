# Memory, characters and file uploads

## Long-term memory

Memory is **one shared list of short facts about you** (for example “Works with STM32
microcontrollers”, “Prefers answers in Persian”). It is used by every chat, and every
character, that has memory switched on.

### How it reaches the model

Before each request, the server appends the memory block to the system prompt:

```
<character instructions>            ← if the chat uses a character

<chat system prompt>                ← if set in Chat settings

Long-term memory — facts the user has shared in earlier conversations. ...
- Prefers answers in Persian.
- Works with STM32 microcontrollers.
```

The block's wording comes from `config/prompts.json` (`memory.block`, `memory.item`), and
the parts are joined with `systemJoiner`. Memory costs input tokens on **every** request,
so keep it short. `memory.maxItems` and `memory.maxItemChars` bound it.

### How facts are added

| Way | Details |
|-----|---------|
| Manually | Sidebar → **Memory** → type a fact → **Add**. Facts can be edited or deleted there. |
| Automatically | After each complete answer (not after *Stop*, errors or *Regenerate*), the server makes **one extra non-streaming request** to a model with the instruction in `prompts.json → memory.extract`. It sends the numbered existing memory and the **last `autoExtract.contextMessages` messages** of the chat (default 6). The model returns `{"add": [...], "remove": [numbers]}`. |

What the extractor is told to do:

- **Explicit requests always win.** “Remember this”, “don't forget”, «یادت بمونه», «به خاطر
  بسپار» and similar phrases are always saved, even for task-specific details and even when
  the information itself was given in an earlier message. That is why several recent
  messages are sent, not only the last one.
- Otherwise, only durable facts you state about yourself are saved: name, profession,
  projects, tools, preferences, goals.
- “Forget …” or a correction removes the outdated entry (and adds the corrected one).
- Duplicates are ignored (case- and punctuation-insensitive). Limits per answer:
  `maxAddPerTurn`, `maxRemovePerTurn`.

The UI shows **“Memory updated: …”**, **“Forgotten: …”**, or **“Memory could not be
updated: …”** when extraction fails. The raw model answer is then logged
(`Memory extraction returned no usable JSON`). The JSON is accepted even when the model
wraps it in a code block or adds text around it.

Automatic extraction settings (`config.json → memory.autoExtract`):

- `enabled`: switch it off to use manual memory only.
- `providerId` + `modelId`: the model used for extraction. When both are `null`, the
  chat's current model is used. A small, cheap model is recommended, for example set
  `"providerId": "openrouter", "modelId": "<a cheap model id>"`.
- `contextMessages`: how many recent messages (yours and the assistant's) the extractor
  sees (default 6).
- `maxContextChars`: maximum characters per message sent to the extractor (cost control).
- `timeoutSeconds`: extraction is abandoned after this time; the chat is unaffected.

Extraction runs **after** the answer has been fully delivered, so it never delays the
answer. It also completes if you close the page or switch chats in the meantime.

### Troubleshooting: “a new chat doesn't remember anything”

1. Open Sidebar → **Memory**. Memory is injected into every new chat with any provider and
   model, so if the fact is listed there, it is being sent.
2. If the list is empty, look at the server log for `Memory extraction failed` or
   `returned no usable JSON`. Small models sometimes answer with prose. In that case set a
   more capable extraction model in `memory.autoExtract.providerId` / `modelId`.
3. Check that memory is on for both chats (Chat settings → “Use long-term memory in this
   chat”) and that the character used does not switch it off.
4. You can always add a fact manually in the Memory dialog.

### Per-chat switch

**Chat settings → “Use long-term memory in this chat”.** When it is off, memory is neither
injected into that chat nor updated from it. New chats take the default from
`memory.defaultOnForNewChats`, or from the selected character.

Global kill switch: `memory.enabled: false`.

### Privacy note

Memory is stored in `data/memory.json` on your server. Facts are sent to whichever provider
and model you chat with, and to the extraction model.

---

## Characters

A character is a reusable persona:

| Field | Effect |
|-------|--------|
| Emoji + name | Shown on the start screen, in the top bar and in the sidebar. |
| Description | Tooltip on the start screen; shown in the character list. |
| Instructions (system prompt) | Sent as the first part of the system prompt of every chat that uses the character. |
| Default model | Pre-selected when you start a chat with this character (optional). |
| Default temperature | Pre-set for new chats (optional; empty = global default). |
| Use long-term memory | Default of the per-chat memory switch. |

Manage characters in Sidebar → **Characters**. On an empty chat, the start screen shows the
characters as chips; pick one before sending the first message. The choice is stored with
the chat.

Editing a character's instructions affects **all** its chats from the next message on,
because the prompt is read at request time and not copied into each chat. Deleting a
character keeps its chats; they simply continue without the character's instructions.

Storage: `data/characters.json`. Limits: `config.json → characters`.

---

## File uploads

Attach files with the paperclip button, by drag & drop onto the chat, or by pasting.
Files are uploaded immediately and stored on the server in `data/uploads/`. The chat only
stores references, which keeps conversations small and makes large files (video) possible.

| Kind | Extensions (configurable) | Max size (default) | Sent to the model as | Works with |
|------|---------------------------|--------------------|----------------------|------------|
| Image | png, jpg, jpeg, webp, gif | 5 MB | `image_url` (base64 data URL) | models with the **vision** badge |
| Video | mp4, mpeg, mov, webm | 50 MB | `video_url` (base64 data URL) | models with the **video** badge (currently only some OpenRouter models, e.g. Gemini) |
| PDF | pdf | 20 MB | extracted **text** | every model |
| Word | docx | 20 MB | extracted **text** | every model |
| Text / code | txt, md, csv, json, c, h, py, js, … | 2 MB | the file's **text** | every model |

### Documents

Text is extracted once, at upload time: PDF with `pdfjs-dist`, DOCX with `mammoth`, text
files as UTF-8. It is sent as

```
<attached_file name="report.pdf">
…text…
</attached_file>
```

placed before your message (template: `prompts.json → attachments.document`). Limits:
`attachments.maxTextChars` (default 200,000 characters) and `attachments.maxPdfPages`.
When a limit cuts the text, the chip shows **truncated** and the model is told so.

Limitations:

- **Scanned PDFs** (images of pages) have no text layer. The model receives a note that no
  text could be extracted. There is no OCR.
- DOCX: only the text is extracted. Images, charts and layout are dropped.
- Legacy `.doc` (Word 97–2003) is not supported; save it as `.docx`.

### Images and video

- A warning appears if the selected model does not report image support. For video, you
  are asked to confirm before sending.
- Clean APIs accepts at most **8 MB per request**, including all images of the whole
  conversation, because history is re-sent on every turn. Larger requests are rejected
  with a clear message before anything is sent (`providers[].maxRequestBytes`). Start a
  new chat or remove attachments if you hit it.
- Video is sent in full as base64. That is about 33 % larger than the file and can be
  expensive. Short, compressed clips are recommended.

### Lifecycle

- Upload → the file belongs to no chat until the message is sent. Removing it from the
  input box deletes it.
- Unsent uploads older than `attachments.orphanUploadHours` are deleted automatically.
  Cleanup runs at start-up and every `cleanupIntervalMinutes`.
- Deleting a chat deletes its files.
- Files are served back only to logged-in users (`GET /api/uploads/<id>`). Images and videos
  are served inline for previews; documents only as downloads.
