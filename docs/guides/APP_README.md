# UFriend user guide

[English](APP_README.md) | [繁體中文](APP_README.zh-TW.md)

UFriend is a Windows desktop assistant that brings together email, meeting transcripts, OCR, and local LLM workflows. It opens with an empty workspace and no demonstration content.

For a packaged release, environment setup, or building from source, start with the [installation and build guide](INSTALL_BUILD.md). You can choose local or cloud processing for each model task; see the [model sources guide](MODEL_SOURCES.md). Local service requirements are covered in the [PC models guide](PC_MODELS.md).

## Opening the app

Download and double-click the UFriend Windows EXE. No installation, manual extraction, separate FFmpeg installation, or 7-Zip installation is required. On each launch, the launcher extracts the app into a separate temporary folder. Your work and credentials remain in the Windows user data directory. Keep the original EXE: restarting from the system tray launches that file. Do not move or replace it while the app is running.

For a folder or ZIP release, extract the entire package before running `UFriend.exe`, and keep the adjacent DLLs, `resources` folder, and license files. See the [installation and build guide](INSTALL_BUILD.md) for downloads and updates.

**Before opening a new version, right-click the old UFriend system tray icon and choose “Quit UFriend.”** Closing the window normally leaves the app running in the background. Only one instance can run at a time, so launching the new EXE while the old version is running may simply bring the old window forward. You do not need to delete your work data when updating.

- Click UFriend at the top left to return to the home page. Settings is at the bottom left.
- By default, closing the window leaves the app in the system tray. Right-click its icon to choose “Open UFriend,” “Restart UFriend,” or “Quit UFriend.” Restarting saves working drafts and stops tasks before opening the same version again. You can disable background operation in Settings → General.
- Automatic clipboard image capture is off by default. After you enable it on the OCR page, the app receives new clipboard images. It only reads new images and does not capture an image already on the clipboard at startup.
- Local data is stored in `%APPDATA%\UFriend\workspace` by default. Settings → General → “Open data folder” shows the actual location.

## Settings categories

Open Settings at the bottom left, then choose a category from the fixed second-level menu. You can switch categories while scrolling the content. In a narrower or shorter window, the six categories appear above the content instead. The menu supports the arrow keys and Home/End. When credentials need attention, a notice appears above the category content.

| Category | Contents |
| --- | --- |
| General | Light/Dark/System theme, app language, LLM preferred language, background operation after closing the window, media runtime, data cleanup, data location, and version. |
| Personal information | Name, phone, personal/work email, company, job title, additional background, and whether to share it with the model. |
| Email accounts | Google sign-in, accounts and synchronization, sync timing, daily email organization, and advanced Google connection settings. |
| Models and compute | Separate default sources for the text LLM, OCR, and speech; local PC API endpoints, the reserved UGen300 option, local policies, and cloud endpoints, models, parameters, and encrypted keys. |
| Prompt settings | “Open prompt debugger” lets you adjust instructions and text templates for the four LLM tasks. |
| Diagnostic logs | Open the diagnostics folder and export diagnostic logs. |

Switching categories preserves unsaved language, personal information, email connection and sync settings, endpoints, keys, and model policy form values during the current session. Settings with a Save button still require saving to take effect. Unsaved values are not restored after restarting the app; only saved settings are restored. Immediate options, such as the theme and background operation, apply when selected. The Local models/Cloud models tabs in model settings only switch the configuration view; each task chooses its source separately.

“Connect mailbox” on the home page and completion of Google authorization open “Email accounts” directly. “Back to settings” in the prompt debugger returns to “Prompt settings.”

## App language

Open Settings → General → App language, choose “Traditional Chinese” (`zh-TW`) or “English” (`en`), and click “Save app language.” Traditional Chinese is the default. Saving immediately updates menus, buttons, fixed notices, the system tray menu, and date formats without restarting. The choice is retained when you reopen the app. In the Traditional Chinese interface, the same controls are “設定 → 一般 → 軟體介面語言” and “保存介面語言.”

Changing the language only updates the interface. It does not restart the app or cancel an active chat, writing polish, translation, email analysis, OCR, or transcription task. Source emails, input and drafts, generated content, translations, transcripts, and prompts retain their original text. Errors and diagnostic content returned by external services, and existing history, are not translated automatically either.

## LLM preferred language

Settings → General → “LLM preferred language” controls the language preferred for LLM chat replies and is saved separately from the app language. Changing the interface to English does not change the LLM preferred language (`preferredLanguage`), translation source/target languages, or model prompts.

The eight options are Traditional Chinese, Simplified Chinese, English, Japanese, Korean, Spanish, French, and German. Click “Save language” to apply the choice. If you explicitly request another language, the model follows that request. Saving a different **LLM preferred language** stops the chat response currently being generated and preserves the question; existing successful answers are not rewritten. See [LLM preferred language](LLM_FEATURES.md#llm-preferred-language).

## Data cleanup

Settings → General → “Data cleanup” shows the amount of data in each category. After clicking a delete button, check the scope and counts in the confirmation dialog. “Cancel” keeps the data; deletion runs only when confirmed. **Cleanup also removes the corresponding data from local automatic backups. The app cannot restore deleted data.**

| Button | Deletion scope |
| --- | --- |
| Delete all meeting audio | Deletes imported audio copies, audio meeting items, and their transcripts. It also cleans up managed audio copies left after individual items were removed. Active audio transcription is stopped. Videos, original source files on your computer, and shared files still used by another item or feature are retained. |
| Delete all chat history | Deletes all LLM conversations, messages, and unsent drafts, and stops any response being generated. One empty “New conversation” remains, ready for input. |
| Delete all system logs | Clears UFriend activity logs and the current and rotated diagnostic files: `events.jsonl` and `events.1.jsonl` through `events.9.jsonl`. New logs are created normally as you continue using the app. Independent PC API services manage their own logs. |

Meeting audio cleanup is temporarily disabled while media is being imported; wait for the import to finish. If cleanup does not finish, the confirmation dialog shows the reason and allows a retry. If another program is using an audio file, close that program and try deleting again. An error can occur after some data has already been removed, so use the updated counts in the dialog.

## Available features

| Feature | Implemented operations |
| --- | --- |
| Home / email organization | Asks the LLM to summarize each email, then assigns one of seven categories using only the final summary. If quality or capacity is uncertain, it can save explicitly labeled source excerpts and mark the priority as needing review. The summary card inside an email shows only the summary and category, with the full original message below. Long emails have chunk progress and cancellation. Category filtering and daily organization are supported. Unchanged emails are skipped within the same Taipei calendar day and reassessed the next day; manual priorities are preserved. [Instructions](LLM_FEATURES.md#per-email-summaries-and-categorization). |
| Local email | Import `.eml` files, parse Chinese text and MIME, save attachments, deduplicate messages, search text and senders, and filter by source, date, or folder. |
| Email reading | HTML email retains tables, font styles, paragraphs, images, and inline links. The reading area follows the light/dark theme. Embedded and external images, retrying failed loads, and plain-text email are supported. |
| Email management | Read/unread, stars, archive, spam, trash, labels, and moving messages back to the inbox. Local email changes are saved locally; Gmail operations are synchronized to the original mailbox, with partial failures reported. |
| Email composition | Recipients, CC/BCC, reply, reply all, forwarding, attachments, and saving, reopening, or deleting drafts. Sending is available when a usable Gmail account is connected. |
| Gmail | OAuth with PKCE/state in the system browser, a local callback, encrypted tokens, initial import and incremental synchronization, scheduled sync, multiple accounts, disconnect/reauthorization, and source links. Import your own Google Desktop OAuth configuration before signing in with Google. |
| Gmail drafts | Synchronize existing remote drafts, preserve reply threads and attachments, and check the remote version before saving. Conflicts preserve local content; you can keep a copy before loading the latest Gmail version. An uncertain send is never retried automatically. |
| Meeting notes | Drag in or select audio/video, confirm the language, and transcribe sequentially or choose a start time. Schedules can be edited or canceled. Open a card to view the video player on the left and transcript with CC captions on the right. Timestamp seeking, TXT/SRT export, and MP4 export with burned-in subtitles are supported. No-speech results and failures are shown separately. |
| Manual transcripts | Import or edit SRT/TXT and reopen saved content; exports create real files. SRT timestamps can seek playback. Plain TXT does not invent timestamps. |
| OCR workspace | Event-driven capture, manual clipboard capture, or image import; real PP-OCRv5 recognition; cancellation, source comparison, manual editing, and copying. A new image clears the previous result, and a blank image does not produce fabricated text. |
| LLM chat | Displays text as it is generated. Create, switch, rename, or delete conversations, each with its own saved successful exchanges and draft. Switching conversations stops current generation; incomplete answers are excluded from history. Requests include this conversation and enabled personal background, without automatically attaching emails or files. |
| Text translation | Choose source/target languages, enter source text, start/cancel, and copy the translation. The source language can be detected automatically. Changing the text or language clears the previous translation and prevents a late result from overwriting new input. |
| Writing polish | Saves the purpose, tone, and source text, and calls the model only after you click “Generate text.” Supports cancellation, manual editing, and copying. Changing input or options cancels old generation and clears the result; late responses cannot overwrite new input. |
| Model management | Saves three residency policies and an idle timeout. Simulated devices verify same-model reuse, queuing, cancellation, disconnection, and idle policies. These timed jobs do not run models. |
| Settings and logs | Six settings categories, Traditional Chinese/English UI, Light/Dark/System theme, background operation, sync timing, API settings, Windows-encrypted credentials, persistent system logs, and JSON export. Each of the four LLM prompts can be saved or reset separately. Diagnostic logs can be opened or exported. General includes cleanup for meeting audio, all conversations, and system logs. |
| Personal preferences | LLM preferred language is used for chat and is separate from the app language. Save a name, phone, personal/work email, company, job title, and additional background, and choose whether to share them with chat, writing polish, and email analysis. Translation continues to use its own target language. |

Outlook, Yahoo, and other mail providers are not supported yet. Daily email organization is enabled in Settings. There is currently no separate task list or calendar, and no Google or Outlook Calendar integration.

## Meeting notes and scheduling

Drag audio or video onto the Meeting notes page, or click its upload area, to open the import dialog. Click “Choose files” to add media, check the filenames, choose the transcription language, then select “Import only; transcribe later,” “Add to queue now,” or “Choose a start time.” Click “Confirm import” to proceed. Canceling before confirmation does not copy the files. You can import up to 30 files at once. All files in one import share the language and transcription settings, and the app reports successful and failed imports afterward.

For an imported meeting, click the play icon on its card or detail dialog to add it to the queue, or the calendar icon to schedule it. One file is processed at a time. Jobs scheduled for later do not block other eligible jobs, and jobs due at the same time run in the order they were added. Queued/scheduled items show their status and let you edit or cancel the schedule. Canceling a schedule preserves the media and meeting content. If Whisper reports that it is busy, the queue keeps the job and retries every 5 seconds. Other errors appear on the card, and processing continues with the next item.

**Schedules use this computer's time zone, and UFriend must remain open or running in the system tray.** Schedules are saved. Jobs that become due while the app is closed or the computer is asleep are queued when the app resumes. Scheduling does not wake the computer or launch an app that has been quit. Quitting pauses the transcription in progress; adding it back to the queue restarts transcription from the beginning. Jobs that have not started, and their scheduled times, are retained.

Click a blank area of a meeting card, its name, or the document icon on the right to open playback and the transcript. In a wide window, video appears on the left and a scrollable subtitle timeline on the right; a narrow window stacks them vertically. Clicking a timestamp seeks the video while preserving its playing/paused state. The current subtitle segment is highlighted during playback.

A video with a timed transcript displays CC captions by default; use “Captions CC” to toggle them. Captions use the player's native text track in normal and full-screen playback and come from Whisper transcription or an imported SRT. Plain TXT has no timing information, so it does not create captions or invented timestamps. Native playback remains limited to media codecs supported by Chromium.

## Exporting video with burned-in subtitles

Open a video card in Meeting notes and first finish transcription or import an SRT with start/end times. If the text needs correction, click “Edit text” and save it first. Below the video, click “Export video with subtitles,” choose a local save location and a new `.mp4` filename, and start the export. This option is not available for plain TXT or audio-only items.

The export burns the subtitles as they exist when the export starts into the bottom of the video, using white text with a black outline. Traditional Chinese and English wrap according to the frame width. Output uses MP4 with H.264 video and AAC audio from the first audio track. Videos without audio can also be exported. The subtitles become part of the picture, remain visible in other players, and cannot be turned off with CC. The original video is preserved, and existing output files are not overwritten; choose a new filename.

Only one video can be exported at a time. Progress is shown during export, and “Cancel export” is available. Cancellation waits for the conversion process to exit and temporary files to be cleaned up before restoring the controls. Closing the detail dialog or switching pages does not stop the export. The meeting card shows progress, and reopening it lets you continue monitoring. After success, click “Show exported file” to view the result. Editing the transcript does not change an export already in progress; export again to apply new text.

Quitting or restarting UFriend from the system tray cancels unfinished exports, which must be started again next time. Export uses the local CPU; duration depends on video length, resolution, and computer performance. A percentage is shown when video duration can be read; otherwise the app shows processing status. Leave enough disk space for the full video and temporary files. Save failures are explained on screen.

The current Windows release includes the media runtime and can export completed subtitles without starting Whisper. Settings → General → Media runtime shows that it is bundled. For an older or self-built version without it, use “Download and install media runtime” on the same page (requires an installed copy of 7-Zip), or “Select extracted package” to choose the pinned official Gyan package. An optional installation is saved in the user data directory and survives restarts and EXE updates. See the [FFmpeg runtime guide](../development/FFMPEG_RUNTIME.md).

## Reading email

Open a message from the home page or email list. HTML email displays tables, font styles, paragraphs, images, and inline links in an isolated reading area. It follows UFriend's Light/Dark/System theme. Dark mode adjusts backgrounds, text, and table borders for readability while preserving image pixels. Changing the theme does not reload the message or change its saved original content. Plain-text-only email remains readable.

Supported images include embedded CID/Base64 images and external PNG, JPEG, GIF, WebP, BMP, and ICO images. External images are loaded without cookies or referring-page information. If message content or an image fails to load, an inline notice allows a retry. `http`/`https` links open in the system browser; `mailto` links open in the system email app. Scripts, forms, and embedded web pages are filtered out, and the reading area also prohibits script execution.

If an older synchronized Gmail message lacks HTML, opening it fetches and caches the reading content from Gmail. This read-only fetch preserves read status, stars, labels, and analysis results. For an older imported local EML that retained only plain text, importing the same original `.eml` again restores HTML. Deduplication updates the existing message while preserving file associations, state, and analysis instead of creating a duplicate.

Email analysis uses a plain-text copy and replaces web URLs in the subject and body with `【網址】` before summarization. Original-message reading, search, and replies retain complete URLs. Unread image and attachment content is tracked separately, and the summary card shows only the summary text and category. Displaying an image in the reading area does not mean OCR has been performed. Email organization does not automatically read images or full attachment content. In this version, composition and sending continue to use the existing plain-text workflow.

## Connecting Gmail

Both the public release and source code use a blank OAuth configuration template. Follow the [Gmail setup guide](GMAIL_SETUP_GUIDE.md) to create your own Google Desktop OAuth client and download its JSON file, then:

1. Open UFriend → Settings → Email accounts → Advanced settings (developers), click “Import Google configuration,” and select the original JSON file.
2. Click Google sign-in, choose an allowed account in the system browser, and review and approve the requested Gmail permissions.
3. Return to UFriend, confirm that the account appears, and let synchronization finish. The initial sync window in days and the automatic sync interval can be adjusted separately.

Importing or manually configuring an account overrides only this computer's connection settings, without changing the source template. Clearing the override returns the public version to an unconfigured state. Do not publish OAuth downloads, secrets, or tokens.

The app requests the `gmail.modify` scope for reading, managing, drafting, and sending email. It does not offer permanent deletion that bypasses Trash. Allowed accounts, authorization validity, and production release requirements depend on the Google OAuth project being used; see the [Gmail setup guide](GMAIL_SETUP_GUIDE.md).

The app controls the read rate for each account and automatically waits and retries when Google reports temporary rate limiting. Initial synchronization of hundreds of messages may take several minutes; “Last sync” is updated only after completion. Permission, disabled API, organization policy, and quota errors have their own guidance. Sending and other modifying operations are not automatically repeated by this retry mechanism.

The sync button shows a spinning icon and “Syncing…” and disables duplicate actions while synchronization is running. It returns to normal on success or failure. The empty home page follows the product theme: a connected account shows “Sync mail,” while an unconnected workspace shows “Connect mailbox” and opens Settings. The Google authorization button remains in Email accounts settings.

Without Gmail connected, you can import EML files to try local email operations. Composed content is saved as a draft and is never presented as sent. Gmail sync, sending, and draft failures preserve local content. If a send result is uncertain, check Gmail's Sent folder before deciding whether to retry.

## Using a PC text model

Text generation uses the independent `PC-LLM-API` service. That project manages its models and runtime; they are not included in UFriend's source or portable release. Obtain the service source separately and install it according to its README. The brief topic summaries described here correspond to PC-LLM-API 0.1.10. If a compatibility notice appears, check the service README, update the required service, and restart it. See the [PC models guide](PC_MODELS.md) for the three services' environments, default endpoints, and startup instructions.

1. Start `PC-LLM-API` and wait until the model is ready. The default endpoint is `http://127.0.0.1:8765`.
2. In UFriend → Settings → Models and compute → Local models → Local backend, choose “PC local services,” check and save the endpoint, then test the connection.
3. Return to the feature you want to use, choose “Local,” and start email analysis, writing polish, chat, or translation. You can also choose a configured cloud source for that task. If the service stops, the app reports an error and preserves the source content. See the [LLM guide](LLM_FEATURES.md).

“Organize new / changed mail” processes inbox messages that need updating when the batch starts, including read and already-handled messages. Each email is summarized first and then categorized using only its final `summary`. If content checks or capacity limits cause “Source excerpts” to be saved instead, categorization receives that final saved text. The app locally converts Simplified Chinese in summaries and priority reasons to Traditional Chinese. Existing summaries also display in Traditional Chinese without reanalysis. Original messages, verbatim quotations, URLs, and code are preserved. The organization button, AI source selector, and batch progress are grouped on the home page and inbox. The email detail view retains priority, handling and move actions, the summary, and the original message; it does not show a single-message reorganization button or batch statistics.

The displayed priorities are `0 = Reply first`, `1 = Handle today`, and `2 = Handle later`. The API meanings are, respectively: an explicit deadline today or an explicit immediate action for the user; an ordinary task for the user today; and no task today or an action due in the future. Uncertain results show “Needs review” without applying the model priority; manual settings are preserved. A category, a message sent by the user, or the absence of words such as “please” cannot alone prove that there is no task. The system does not directly change such a message to “Handle later.”

Each email first attempts a full-text summary. If input is too long, output reaches its limit, or repetitive generation is detected, the app selects source text in chunks, retaining identifiable important dates, amounts, states, conditions, and context. If necessary, it selects again from candidate source text before combining the result. Progress shows “Completed i / n segments,” and cancellation is available. If selection or composition still exceeds capacity and verifiable source text is available, the app can save labeled “Source excerpts” with “Needs review,” instead of treating an unfinished model response as a successful summary. Cancellation, timeouts, format errors, and quotation errors still fail. Local and cloud processing follow the same flow and never switch sources automatically.

The “Summary and category” card shows only the complete saved summary and category. It no longer lists source facts, quotations, quality notices, model suggestions, reasons, or generation details. The full original email remains below, and existing messages display without reorganization. By default, a summary is just a brief topic or purpose phrase, such as “影音內容推薦” (“Media recommendations”) or “付款完成通知” (“Payment confirmation”), describing the broad direction of the current message's top-level body. Identifiable quoted older messages and subsequent replies are excluded. The summary does not reconstruct the send/reply sequence or enumerate every secondary detail; the full original is still available in the reading area. Omitting a promotion threshold or date does not by itself replace the summary with a long source excerpt. If only the task reason is problematic, the valid summary remains and only priority application is withheld. Limited checks still cover added currencies, some numbers/codes/durations, attachments, and explicit contradictions in conditions. These content checks are limited, so summaries still need to be checked against the original.

The analysis cache includes original text/URLs, sender address, attachment/image state, recipient and model settings, and the Taipei calendar date. Unchanged messages are skipped on the same day; organizing again the next day reassesses that day's tasks. A batch that crosses midnight continues to use its starting reference date. Changes to read status, stars, labels, or manual priority alone do not trigger recalculation.

Analysis writes only local summaries, source facts, categories, and priorities. It does not send email, change Gmail labels, or create calendar events. The user's identity comes from the account associated with the message and is not guessed when there is no matching account. Summarization receives URL-replaced text, message date, sender name/address, To/CC, the user's address, the batch reference time, and attachment/image content status. It does not receive OAuth tokens, API keys, attachment files, or BCC. Categorization receives only the final summary. Canceling aborts requests and preserves completed items. Messages moved away or whose source state changes during analysis are skipped.

The complete prompt, email fields, history, and reserved output all count toward the PC service's 8,192-token limit. Chunking and source excerpts still have capacity and time limits; when processing cannot complete, the original remains and an error is shown. Ordinary full-text summaries use personal background and custom prompts. Chunk selection, composition, and categorization use fixed prompts without those settings. Explicit model-control text may cause the service to require manual review. This is a limited conservative check, not a guarantee of complete prompt-injection protection. PC latency is also not evidence of UGen300 speed, power consumption, or USB stability.

## Saving and recovery

- `state.json`: email cache, drafts, settings, media/image indexes, manual content, model analysis results, and logs. Email analysis saves the summary or labeled source excerpts, source facts, quality notices, suggested priority, reasons, quotations, timestamps, and model source. Completed items survive an interrupted batch.
- `state.backup.json`: the previous confirmed version. If the current data file is damaged, the app can recover from the backup and preserve the damaged file. Data cleanup also removes the corresponding data from this automatic backup.
- `files/`: imported copies of attachments, audio/video, and images. Original source files are not modified.
- Conversation history and each conversation's draft, translation source text/languages/successful result, and saved custom prompts are stored in this workspace. Incomplete chat streams are not saved as successful history.
- `diagnostics/events.jsonl`: local diagnostic logs, up to 2 MiB per file and up to 5 retained files. Open the location or export logs from Settings → Diagnostic logs or the System logs page. See the [LLM guide](LLM_FEATURES.md) for matching error codes and request IDs to backend logs.
- `credentials.bin`: Gmail credentials and API keys encrypted with Electron `safeStorage` and the Windows user account. General data is not protected by full-disk encryption provided by UFriend; use your own Windows account.
- If credentials are damaged or cannot be decrypted after changing Windows accounts, other local features remain available. Settings offers “Reset credentials,” which preserves the old file before you configure accounts/keys again.
- Removing one meeting or clearing OCR removes workspace records/associations while retaining managed files. Data cleanup → “Delete all meeting audio” can remove managed audio copies, including files left after earlier individual removals. Videos and shared files still used by other features are retained.
- Before backing up or moving ordinary data, quit UFriend completely, then back up the entire `workspace`. Credentials should not be treated as portable across Windows accounts; authorize again after moving to another computer.
- FFmpeg installed through Media runtime settings is stored under `media-runtime/ffmpeg/` in the user data directory, outside `workspace`. It is not placed in the single EXE's temporary extraction directory, so it survives app restarts and updates. Workspace cleanup does not remove it.

## Model processing and data boundaries

Local processing uses the three PC APIs on this computer for text, images, or media. Cloud processing can connect to an OpenAI-compatible API with models configured separately for each feature. UFriend does not download, start, or stop local services, and closing the desktop app does not stop them. Local endpoints accept only loopback HTTP.

UGen300 is a local connection option, but physical hardware is not integrated yet. Each task retains its own local/cloud source and does not switch to another source automatically on failure. Timed scheduling on the model management page is a simulation and is not evidence that hardware has loaded a model or completed inference. See the [model sources guide](MODEL_SOURCES.md) for meeting sources, schedules, and data transmission scope.

Model jobs send only the input needed by that feature. Chat uses the current conversation and enabled personal background; email analysis uses one email's text and necessary fields; OCR and transcription send the selected image or media. Model results cannot trigger email sending/deletion, calendar creation, or program execution. See the [model interface documentation](../../app/models/README.md) for API fields and cancellation/validation boundaries.

Gmail synchronization and sending connect to Google. Reading external images connects to their host websites. Local model inference does not mean that every feature works offline.

## Installation, building, and verification

The [installation and build guide](INSTALL_BUILD.md) covers environment requirements, running from source, preparing FFmpeg, testing, packaging, and release cleanup. See the [Gmail setup guide](GMAIL_SETUP_GUIDE.md) for Google sign-in configuration and the [PC models guide](PC_MODELS.md) for installing and starting the independent model services.
