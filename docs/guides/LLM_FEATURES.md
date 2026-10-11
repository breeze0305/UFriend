# LLM features and debugging guide

[English](LLM_FEATURES.md) | [繁體中文](LLM_FEATURES.zh-TW.md)

Applies to UFriend 0.1.41. Default brief topic summaries require PC-LLM-API 0.1.10 or later. Cloud processing supports OpenAI-compatible APIs. [Back to the desktop user guide](APP_README.md) · [Model sources guide](MODEL_SOURCES.md) · [PC service startup guide](PC_MODELS.md)

Settings has six categories in a fixed menu. In a narrower or shorter window, the categories appear above the content. Switching categories preserves unsaved form values for the current session, but settings that require saving still need their corresponding Save button. Restarting restores only saved settings. See [Settings categories](APP_README.md#settings-categories) for all entry points.

[HTML email reading](APP_README.md#reading-email) preserves the original layout, images, and links. Email analysis still uses the plain-text original and does not send HTML or images to the LLM. Search, replies, and sending continue to use the existing plain-text workflow.

## App language

In Settings → General → App language, choose Traditional Chinese (`zh-TW`) or English (`en`). Clicking “Save app language” immediately updates menus, buttons, fixed notices, the system tray, and date formats. The choice is retained when the app is reopened. The Traditional Chinese entry is “設定 → 一般 → 軟體介面語言.”

Switching the interface language only changes the display. It requires no restart and does not cancel active model jobs. It does not change the LLM preferred language (`preferredLanguage`), source emails, user input or drafts, generated results, translation source/target languages, or prompts. Translations, errors and diagnostic content returned by external services, and history retain their original content rather than being translated automatically.

## Connect the PC service first

Obtain the independent `PC-LLM-API` project separately, install and start it according to its README, and wait for the model to be ready. The service source, models, and runtime are not included in the UFriend repository. See the [PC models guide](PC_MODELS.md) for requirements. In UFriend → Settings → Models and compute → Local models → Local backend, choose “PC local services,” enter `http://127.0.0.1:8765` as the LLM endpoint, save it, then click “Test connection.” Choose “Local” for each text task. Enter the root URL without adding `/v1/llm`. The connected service must support the LLM preferred language and personal background features.

Four text tasks share this service: email analysis, writing polish, LLM chat, and text translation. It processes one job at a time; retry later if it is busy. The desktop app does not download or start models, and a failed local service does not cause an automatic switch to the cloud. OCR and Whisper have their own services; see the [PC guide](PC_MODELS.md) for startup instructions.

A chat reply is considered complete only when its returned data and metadata do not indicate truncation, incompleteness, or an abnormal stop. Otherwise it is not saved as complete history, and the entered question is retained for retrying.

## Per-email summaries and categorization

The desktop app uses [OpenCC](https://github.com/nk2028/opencc-js) (`opencc-js` 1.4.2) to convert Simplified Chinese in email summaries and priority reasons to Taiwan Traditional Chinese. It validates source quotations and content through the existing workflow before converting the final summary. The categorization model receives the same Traditional Chinese summary that is saved. This step runs entirely locally and adds no model calls. Previously saved summaries display in Traditional Chinese without rerunning the model, changing the cache, or writing back old data. Original emails, subjects, senders, source facts, and verbatim quotations remain unchanged. URLs, email addresses, and code in summaries retain their original strings. LLM preferred language remains a chat setting; email summaries retain the existing Traditional Chinese requirement.

On the home page or inbox, click “Organize new / changed mail” to process new or changed messages currently synchronized to the local inbox, including read messages and those already marked handled. The LLM first generates a summary for each email, then categorizes only the final saved `summary`. If content checks or model capacity raise concerns, `summary` may become explicitly labeled “Source excerpts.” Categorization still receives only that text, without the full original email, source facts, or personal background. Keywords do not replace the categorization model.

Before summarization, `http://`, `https://`, and explicit `www.` URLs in the subject and plain-text body are replaced with `【網址】` to reduce the model space consumed by long URLs. Both local and cloud processing use this shortened copy. Original messages, HTML reading, complete links, attachments, search, and replies retain their content. The app does not open those URLs to read web pages. Model quotations are matched back to the original text. Quotations that cross excessively long URLs are displayed as original fragments before and after the URL. If the same text contains different URLs, shared text is retained only when the remaining source fragments are identical after removing the program-replaced URLs at each matching position. The app does not guess which link was intended or join the text on either side into a new sentence. A quotation that cannot be verified still produces an explicit failure.

Email summaries cover only the current message's top-level body. Input stops at recognizable reply headers, forwarding separators, or quoted older text; subsequent quotations and replies are excluded from model input, source facts, and fallback excerpts. Common Gmail/Outlook quotation formats are recognized, but text without clear boundaries may remain. The original reading area stays complete. By default, a summary is a single short topic or purpose phrase, such as “影音內容推薦” (“Media recommendations”), “付款完成通知” (“Payment confirmation”), or “會議取消通知” (“Meeting cancellation”). The target is usually about 4–15 Chinese characters expressing the broad topic, without listing dates, amounts, people, recommendation lists, or action steps. It should not add an introduction such as “This email is about,” copy a salutation, or repeat a vague subject such as “Selected for you.” This is a generation target, not a hard truncation of longer output. States that change the main meaning, such as completed or canceled, must still be correct. A summary does not reconstruct the conversation, list sender/recipient roles, or invent tasks to read, reply, or buy. The body takes precedence. Re/Fw/Fwd and recognizable Chinese reply/forward prefixes also cause the inherited subject to be excluded, so an older event does not override a short current body. If no usable subject or body remains, processing fails explicitly. Ordinary new-message subjects are retained as context. If images have not been recognized, the prompt instructs the model not to guess their content. Custom prompt wording remains user-defined, but its analysis scope is also restricted to the top-level body.

Email organization first tries to summarize the current body. If input exceeds capacity, the response reaches the output limit, or repetitive generation is detected, it automatically switches to chunked processing. Each chunk selects important original text and retains identifiable dates, amounts, states, conditions, and adjacent context; it does not keep only the first eight lines selected by the model. If candidate text still exceeds composition capacity, it selects again from the candidate source text, then produces a combined summary, reason, and priority. Chunks are not summarized individually, and separate chunk summaries are not simply concatenated. The UI shows “Completed i / n segments” and the composition state, with cancellation available at any time.

If chunk selection or composition still reaches an input/output limit and verifiable source text is available, the app saves content labeled “Source excerpts” and marks the model priority as “Needs review.” This is neither a completed model-generated summary nor a fragment of an interrupted answer. Cancellation, timeouts, format errors, and quotations that cannot be restored still fail. Excerpts cannot rescue a request without usable source fragments. Chunking has capacity, call-count, and time limits, and the amount of important source text retained is also bounded. Coverage of all meanings and details is not guaranteed.

The summary card shows only the saved summary text and category. It no longer displays source facts, quotations, quality notices, model suggestions, reasons, or generation details. It does not truncate the summary or require existing messages to be analyzed again. The full original remains below. Saved `sourceFacts`, quotations, and quality data remain available to the existing workflow; simplifying the display does not change priority or category results. The summary aims to identify the current body's topic or purpose quickly, rather than trace the send/reply sequence. Missing a date, amount, promotion threshold, or using different wording from a quotation does not alone replace the summary with a long original excerpt; those signals remain in the analysis data. Added currencies, mismatched numbers, fabricated attachments, or explicit contradictions in conditions can still cause a fallback to source excerpts. If only the task reason is problematic, the summary remains and priority review is required. Checks are limited, so compare the summary with the original. A capacity limit on source facts does not by itself invalidate the summary.

An uncertain priority is shown as “Needs review” without applying the model's 0/1/2 value. Priorities manually set by the user are preserved. A topic category, a message sent by the user, or the absence of request wording such as “please” does not alone prove that there is no task today. The system does not directly change the result to “Handle later” on that basis.

Task-evidence checks include negative reminders with decorative prefixes and optional self-service wording such as “If you have questions” or “To view details.” Such text alone cannot prove that the user needs to act today. Conditional requests whose condition has not been confirmed, such as “If payment fails, contact customer support,” remain subject to review. Explicit assignments and independent follow-up requests remain available for interpretation. This check can only mark an uncertain model priority as needing review; it does not choose a different priority for the model.

Known, unrecognized email images in the current body remain recorded as unread content, even when the same message contains plenty of readable text. Images in or after an identified quotation section are excluded. Images and attachments are tracked separately, and these additional notices no longer appear on the summary card. Loading an image for reading does not mean OCR has run. Email organization does not automatically read remote images or full attachment content; those require separate checking.

If a summary cache format is incompatible with the current rules, the next “Organize new / changed mail” run processes it again without directly rewriting the original email. The cache includes original text/URLs, sender address, attachment/image content status, recipient identity, effective settings, and the Taipei calendar date. Successful results are skipped when their data and settings have not changed within the same Taipei day. Organizing again the next day reassesses that day's tasks. A change to an original URL still triggers an update even if the URL-replaced text is identical.

| Category | Content |
| --- | --- |
| Work and collaboration | Projects, deliverables, work discussions, and collaboration. |
| Meetings and events | Meeting invitations, schedule changes, events, and registration information. |
| Billing and transactions | Bills, payments, orders, refunds, and transaction notices. |
| Accounts and services | Sign-in, security verification, and account or service status. |
| Promotions and newsletters | Promotions, subscribed newsletters, and promotional content. |
| Personal correspondence | Family, friends, and ordinary private messages. |
| Other | Content the model determines does not fit the topics above. |

The inbox displays summaries and categories and supports filtering by category. “Unclassified (pending or failed)” includes messages not yet organized or whose categorization failed; it is different from “Other.” Open an email to view its summary and category, with the full content in the original-message reading area below. Organization controls and batch progress are on the home page and inbox. The email detail view does not offer single-message reorganization, but results completed in the background still update while you read. Topic categories do not replace handling urgency.

The categorization prompt uses explicit category descriptions and synthetic examples to help distinguish work correspondence, transaction records, and event marketing. It still reads only the final summary, so a misread summary can also lead to a wrong category. If checks find an internal field name absent from the original, such as referenceTime or evidenceIds, inserted into the summary, the app uses source excerpts and requires review. If only the reason has this problem, only priority application is withheld. This check covers specified fields only.

A usable summary or labeled source excerpts are saved first and remain viewable if later categorization fails or is canceled. On the same day, with other inputs unchanged, the next batch can retry categorization using the saved text. Read status, stars, labels, manual priority, and handled markers do not by themselves trigger recalculation. Each batch fixes one reference time and Taipei date, even if it crosses midnight. Only a later new batch uses the new date. An individual email that cannot finish shows an error while other messages continue.

For local brief topic summaries, update and restart PC-LLM-API 0.1.10 or later. Chunking retains the existing `mail-select`/`mail-compose` contracts. If an older service rejects a required task, the app explicitly asks for an upgrade. Updating service code alone does not require downloading the model again. Cloud processing uses the same chunking workflow and retains the source selected at the start throughout the task; it never switches automatically between local and cloud. Ordinary full-text summarization uses the custom “Email analysis” prompt and enabled personal background. Chunk selection, composition, and categorization use fixed prompts without personal background or custom prompts and are not among the four public prompt settings.

## Daily automatic organization

Settings → Email accounts → “Daily email organization” lets you enable the feature and choose a daily `HH:mm` time. Save to apply it. It is disabled on first use, with 09:00 prefilled. Each day it first synchronizes connected accounts, then organizes messages in the local inbox that need updating, using the default text LLM source at the start. If synchronization fails for some accounts, it still organizes locally available messages. Settings shows the error rather than claiming that all accounts synchronized successfully.

The schedule uses the computer's time zone, and UFriend must remain open or in the system tray. If the scheduled time is missed while the computer sleeps or the app is closed, it runs once when the app resumes that day. It does not catch up multiple days, wake the computer, or launch an app that has been quit. Enabling it after today's scheduled time also triggers a catch-up attempt. If sync, manual organization, chat, translation, or writing polish is active, it waits until idle. Once automatic organization starts synchronizing, it reserves access to the text model; new text jobs must wait until organization finishes.

There is at most one automatic attempt per day. The run date is saved before execution, so restarting, changing the time, or briefly disabling and re-enabling the schedule does not trigger another attempt that day. Failed or interrupted runs can be retried manually. Settings retains the latest automatic organization time, status, and reason. Disabling the schedule only prevents future runs; the current organization can be canceled from the email page.

## Generating polished writing manually

In “Writing polish,” enter what you want to express, select the purpose and tone, then click “Generate text.” Typing, composing text with a Chinese input method, and changing options only save the draft; they do not call the model automatically. Changing the source or options during generation cancels the old job and clears the old result. Click the button again to generate a new result. Leaving the page saves edits and does not cancel generation when the content has not changed.

## LLM preferred language

Settings → General → “LLM preferred language” offers Traditional Chinese, Simplified Chinese, English, Japanese, Korean, Spanish, French, and German. Click “Save language” to apply it. Traditional Chinese is the default. LLM chat prefers this language unless the question explicitly requests another. Saving a different preferred language stops the response being generated and preserves the original question. Completed chat history is not rewritten. This setting does not change the interface language, translation target, or language of other tasks.

## Personal background

Settings → “Personal information” accepts a name, phone, personal email, work email, company, job title, and additional background. Every field is optional. After “Save personal information,” enabled nonempty fields are included as background for LLM chat, writing polish, and ordinary full-text email summarization. They are not attached to translation, email chunk selection, composition, or categorization. Clear the sharing checkbox and save to disable sharing while keeping the form data; clear a field and save to remove its content.

Background only helps interpretation. It does not change real email accounts/recipients, source-quotation requirements, or sending permissions. Do not put passwords, API keys, or system instructions for the model in Additional background. Data is stored in the local workspace's `state.json`. When sharing is enabled, it is sent to the local or cloud LLM selected for the task only when a relevant task runs. Diagnostics do not record the full field contents. Changing effective background stops chat, writing polish, and email analysis jobs using the old background while preserving their original content.

Disabling background only affects future requests. Earlier chat messages may already contain personal information, and that history is still sent within the same conversation. Start a new conversation to test the effect of disabling it. Qwen 1.5B still has limits in following language preferences. In particular, a Chinese question combined with an English preference and personal background may receive a Chinese reply; explicitly state the desired language in the question. Eight available options do not mean that quality has been evaluated for all eight languages.

## Text translation

1. Open “Text translation” from the left navigation.
2. Select “Source language” and “Target language.” The source defaults to automatic detection; the target defaults to Traditional Chinese.
3. Enter text in “Original text” and click “Translate.”
4. Check the translation on the right, then click “Copy translation.”

Source options are automatic detection, Traditional Chinese, Simplified Chinese, English, Japanese, Korean, Spanish, French, and German. The target offers the same eight languages without automatic detection. The language names specify the request; the model can still mistranslate proper names, meaning, or the writing system. Check the result before using it.

Source text is limited to 16,000 JavaScript characters and is also subject to the token budget. Translate in parts when it exceeds capacity; the service does not silently cut off the latter part. Translation can be canceled. Changing the source text or either language clears the old result, and late responses cannot overwrite new input. Source text, languages, and successful translations are saved in the current workspace without entering chat history.

## Multiple conversations and live replies

Enter a question in “LLM chat.” Enter sends it; Shift+Enter adds a line break. Pressing Enter while selecting characters with a Chinese input method does not send the question. New replies appear incrementally and are marked as generating and incomplete until finished. Reading older content does not continually pull the view to the bottom; return to the bottom to follow the newest text.

“Chat history” at the top right opens the conversation list; the label may shorten to “History” in a narrow window. Each conversation saves its successful exchanges, draft, and name separately. Content from other conversations is not sent with this one.

| Action | Behavior |
| --- | --- |
| New conversation | Disabled when the current conversation has no messages, nonblank draft, or pending question. Spaces alone count as blank. When there is content, a new conversation can be created while preserving the original draft. If generation is active, it is stopped first and the original question is retained. |
| Select another conversation | Saves the current draft and opens the selected history. **Switching conversations stops current generation.** |
| Rename | Click the row's pencil icon, enter a single-line name of 1–80 characters, and save. |
| Delete conversation | Click the row's trash icon and confirm to remove its messages and draft. Deleting the active conversation stops generation. Deleting the last one leaves a new empty conversation. |
| Stop | Ends current generation and preserves the question for editing or resending. |
| Copy reply | Copies that successfully completed answer. |

Deletion cannot be undone. To remove content, delete the entire conversation from Chat history. Deleting the last conversation still leaves one empty conversation, with “New conversation” disabled. After the first successful answer, “New conversation” is named from its first question; you can also rename it yourself. A single conversation from an existing workspace is retained in Chat history without manual export and reimport.

To clear all conversations, open Settings → General → Data cleanup → “Delete all chat history.” The confirmation dialog shows conversation and message counts and offers “Cancel.” Confirming stops current generation, removes all conversations, messages, and unsent drafts, and removes corresponding data from local automatic backups. One empty “New conversation” remains so you can keep using chat immediately. Failure reasons appear in the dialog and allow a retry. Deleted data cannot be restored by the app.

Streaming uses actual SSE deltas from the model; all text is a preview until the complete finish event arrives. After a stop, timeout, output limit, or interrupted connection, incomplete text is not saved as a successful answer or included in the next turn's history. The original question is retained. Restarting the app also does not turn an interrupted answer into a successful record.

A request may contain up to 31 alternating messages, at most 16,000 characters per message, and at most 64,000 characters in total. If the model token limit is reached sooner, start a new conversation or shorten the question. The service does not automatically discard older history and pretend the complete conversation fits. Chat processes the current conversation and enabled personal background; it has no permission to read the mailbox, recordings, or files, or execute tools.

## Settings → Prompt settings

Open Settings → Prompt settings and click “Open prompt debugger.” Configure the four tasks separately: email analysis, writing polish, LLM chat, and text translation. “Back to settings” in the debugger returns to the Prompt settings category.

1. Confirm that “Defaults from:” at the top is the PC service you intend to use.
2. Wait for the page to load defaults from `GET /v1/prompts`. Click “Reload defaults” when you need to refresh the service content.
3. Select a task and edit “System instructions” and “User template.”
4. Click “Save {task name} prompt” to save changes to the current workspace. The next request for that task includes these settings. Email chunk selection, composition, and categorization still use fixed prompts.
5. To restore defaults, click “Reset {task name} defaults.” This removes that task's local override, and subsequent requests use the service defaults.

If the service is stopped, too old, or fails to return defaults, fix the connection and reload. Blank content does not overwrite saved settings. Reloading defaults does not save them or delete a saved custom prompt. An edited but unsaved draft is not persistent; reopening the app uses saved settings.

System instructions may be blank and are limited to 12,000 characters. The User template must be nonempty, no longer than 16,000 characters, and contain the required variable. Saving or resetting a task's prompt stops active work for that task, and the next request uses the new settings. Saving a prompt does not rewrite existing successful results.

| Task | Available variables | Required in User template |
| --- | --- | --- |
| Email analysis | `referenceTime`, `date`, `recipient`, `sender`, `to`, `cc`, `lines` | `{{lines}}` |
| Writing polish | `text`, `use`, `tone` | `{{text}}` |
| LLM chat | `text` | `{{text}}` |
| Text translation | `text`, `sourceLanguage`, `targetLanguage` | `{{text}}` |

`{{name}}` is replaced with a JSON-encoded data value. Do not add quotation marks around a variable. For example, a chat User template can be:

```text
Explain the key points in order and preserve line breaks in code. Question: {{text}}
```

For chat, `text` means only the latest question; earlier exchanges are still sent with their original roles. Translation language variables are human-readable names, such as English or Traditional Chinese (Taiwan). Email `lines` includes line numbers and original text from which the model selects quotations. Unknown variables, missing required variables, and incomplete double braces cause saving or the request to be rejected.

Prompt changes affect model instructions only. They do not disable output capacity limits, source-quotation checks for email, number/placeholder checks for writing polish, or complete-generation checks. Email and writing polish must retain their original JSON output requirements. Starting from the defaults makes errors easier to identify. Chat and translation generate text directly and do not need an extra JSON wrapper.

## Capacity and troubleshooting

The PC-LLM-API context covered by this guide is 8,192 tokens. Default full-text email summarization and email composition each reserve 1,536 output tokens. A generated summary must be shorter than 1,000 characters, and its reason shorter than 160. Chunk selection reserves 1,024 output tokens and can select 0–64 lines per call; composition still uses 1–8 quotation lines. Ordinary `mail` with a custom prompt retains its original 512-token output contract. Writing polish and categorization also reserve 512 tokens, while chat/translation reserve 4,096. System instructions, templates, applicable language/personal background, source text, and all history count toward the budget. This is not a limit allowing you to paste the same number of characters. See the [model interface documentation](../../app/models/README.md#task-lifecycle) for technical limits.

Read the error explanation first, then note the error code and any available request ID. A request ID matches the same desktop action to the PC service logs, so technical failures can be located without sharing the original content.

| Error code | Meaning and next step |
| --- | --- |
| `MODEL_API_UNAVAILABLE` | The LLM service is not ready, the endpoint is wrong, or the service stopped. Start it and test the connection. |
| `MODEL_API_BUSY` | Another text task is running. Wait for it to finish or cancel it, then retry. |
| `MODEL_INPUT_TOO_LONG` | Input exceeds capacity or the bounded chunking range. Email processing tries to save labeled source excerpts when source text is available. If this error remains, the original is preserved. For other text tasks, shorten the question, start a new conversation, or translate in parts. |
| `MODEL_OUTPUT_LIMIT` | Generation reached its output limit. An incomplete answer is not saved as a generated summary. If chunked email processing still exceeds the limit, it can save source excerpts and mark the priority for review. Without verifiable excerpts, the error remains. |
| `MODEL_API_INCOMPATIBLE` | The service does not support the required task or response format. Check [PC service versions and interfaces](PC_MODELS.md), update to a compatible service, and restart it normally. |
| `MODEL_STREAM_INTERRUPTED` | The stream did not finish completely. Confirm that the service is still running, then resend the retained question. |
| `MODEL_API_TIMEOUT` | Processing exceeded its time limit. The original is preserved. Check the service and retry with less content. |
| `MODEL_INVALID_OUTPUT` | Structure, source evidence, or completeness checks failed. If you use a custom prompt, try restoring defaults, then use the request ID to inspect the failing stage. |
| `MODEL_INVALID_REQUEST` | Task fields or prompt formatting are invalid. Check required variables and character limits. |
| `MODEL_REVIEW_REQUIRED` | The email contains explicit model-control text and was not analyzed. Preserve the original and review it manually. |

After `MODEL_OUTPUT_LIMIT` or `MODEL_INVALID_OUTPUT`, fragments of an unfinished answer must not be treated as a complete result. “Source excerpts” shown as a capacity fallback come directly from the source and do not mean model generation succeeded. Format or quotation errors cannot bypass validation through this fallback. Match the request ID to `finishReason`, stages, and token counts in the PC backend's `requests.log` to distinguish the cause.

## Opening and exporting diagnostic logs

Settings → Diagnostic logs and the System logs page both provide “Open diagnostics folder” and “Export diagnostic logs.” Opening the location shows the actual directory for the current workspace; export lets you choose a JSON file to save. “Export logs” retains its original purpose of exporting system activity, while diagnostic export additionally provides request stages and technical fields.

The desktop default location is:

```text
%APPDATA%\UFriend\workspace\diagnostics\events.jsonl
```

Each file is limited to 2 MiB, with up to 5 retained files: the current `events.jsonl` and rotated `events.1.jsonl` through `events.4.jsonl`. For another workspace, use the path shown by “Open diagnostics folder.”

Settings → General → Data cleanup → “Delete all system logs” clears UFriend activity and diagnostic files. The confirmation dialog shows counts and offers “Cancel.” Confirming also removes activity records from automatic backups and cleans `events.jsonl` plus `events.1.jsonl` through `events.9.jsonl`, covering files left by higher retention settings. Failures are explained in the dialog and can be retried. Later actions continue to create new logs normally. See [Data cleanup](APP_README.md#data-cleanup) for the full deletion scope.

The PC backend logs independently to `PC-LLM-API/.runtime/requests.log`, with a 2 MiB limit and one retained `requests.previous.log`. The desktop's `X-UFriend-Request-Id` is returned unchanged in the backend response header and success/error data. Use it to match the two logs, then inspect stages such as request, tokenize, inference, decode, and output.

UFriend data cleanup does not delete these PC backend logs or the independent OCR/Whisper service logs. Manage them inside their respective service projects.

Diagnostics use a field allowlist: time, version, request ID, task, error code, stage, character/token counts, duration, and prompt hashes. They do not record source emails/chats/translations, model answers, complete custom prompts, or credentials. This restriction does not mean `state.json` avoids saving user content. The workspace still saves email, conversations, translations, and saved settings so you can continue next time.

The desktop and backends maintain their own versions and logs. See each service's README for synthetic tests and quality limits. The desktop API contract is in the [model interface documentation](../../app/models/README.md). PC tests cannot replace UGen300 hardware performance or quality validation.
