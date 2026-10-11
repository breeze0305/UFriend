# PC Model Services Guide

[English](PC_MODELS.md) | [繁體中文](PC_MODELS.zh-TW.md)

UFriend accesses three independent model services through local APIs. Each manages its own code, models, runtime, startup, and shutdown. They are not included in UFriend's source code or desktop packages. **Currently, obtain the service projects you need separately from the maintainer and install them according to their respective READMEs. Obtaining the UFriend repository alone does not provide these services.**

This guide covers the interfaces and environments of PC-LLM-API 0.1.10, PC-OCR-API 0.1.0, and PC-Whisper-API 0.1.1. After updating a service, stop and restart it normally according to its README so the running service loads the new code. Daily mail organization, meeting scheduling, playback subtitles, and subtitled video export are handled by the desktop application.

| Capability | Independent project | Default endpoint | Model and execution |
| --- | --- | --- | --- |
| Mail analysis, text polishing, chat, and translation | PC-LLM-API | `http://127.0.0.1:8765` | Qwen2.5-1.5B-Instruct Q4_K_M, llama.cpp CUDA |
| OCR text recognition | PC-OCR-API | `http://127.0.0.1:8767` | PP-OCRv5 mobile det + rec, CPU |
| Meeting speech-to-text | PC-Whisper-API | `http://127.0.0.1:8768` | Original multilingual Whisper Small, PyTorch CUDA; Base is optional |

The endpoints expose loopback HTTP on the same computer only. Enter the root URLs above in UFriend without appending `/health`, `/v1/llm`, or `/v1/jobs`. The LLM engine uses port 8766 separately; the desktop application still connects to 8765.

## Environment requirements

All three services require Windows x64 and Node.js 24 or later. Initial installation needs network access and enough space for downloads and extraction. The service README and lockfile you obtain define the actual pinned versions and installation commands.

| Service | Additional environment | Installation contents |
| --- | --- | --- |
| PC-LLM-API | An NVIDIA GPU and driver supporting the CUDA 12.4 runtime; Windows `tar.exe`. The Node side has no additional npm dependencies and does not need Python. | Setup downloads the pinned llama.cpp CUDA runtime and GGUF model. The download is about 1.76 GB; allow additional space for extraction and caching. |
| PC-OCR-API | 64-bit Python 3.10–3.13 with venv support; runs on the CPU without an NVIDIA GPU. Use `UFRIEND_OCR_PYTHON` to specify a compatible Python installation. | Setup creates the project's own venv, installs pinned Paddle packages, and downloads and verifies the OCR models. Python 3.14 is not compatible with this dependency set. |
| PC-Whisper-API | An NVIDIA GPU and driver supporting the selected PyTorch CUDA runtime, and about 10 GB of free space. The current pinned version is PyTorch 2.9.1 cu128. | Setup downloads Python 3.12.10, PyTorch, OpenAI Whisper, Base and Small weights, and FFmpeg. It does not need system Python and reports not ready if CUDA is unavailable. |

Start only the services you need. OCR can run independently on the CPU; the LLM and Whisper services described above require NVIDIA CUDA. The FFmpeg used for subtitle export in the UFriend desktop application and the FFmpeg used for audio preprocessing in the Whisper service are managed separately.

These services implement inference on a PC. Paddle, PyTorch, and GGUF weights cannot be used directly as UGen300 HEF files. Physical UGen300 devices are not yet integrated, and PC performance does not represent device performance.

## Install, start, and connect

1. Obtain each required service project separately and complete initial setup in its own directory according to its README. All three currently provide `npm run setup`. This is an installation step; you do not need to repeat it before every launch.
2. In the service directory, use `Start API.cmd` or the startup command specified in its README. Wait for model loading to finish; the launcher returning does not mean the service is ready.
3. Open **UFriend → Settings → Models and compute → Local models**, and select **PC local services** under **Local backend**. New installations use this method by default; existing settings retain their previous selection.
4. Check the endpoints above, save them, and use **Test connection** for each. A service you intend to use must report API v1 and model readiness. Select **Local** for each task. The Settings page does not switch the source globally; see the [model source guide](MODEL_SOURCES.md).
5. Stop each service according to its README when finished; its `Stop API.cmd` can be used. Quitting UFriend does not stop independent services.

Run service commands in each service's own directory. Do not run their setup or stop commands in the UFriend root. If a service is already installed, first check its status with `npm run health` or UFriend's **Test connection**. Stop that service normally before repairing or reinstalling it.

If a service is stopped, still loading, or configured with an incorrect endpoint, the affected feature keeps the selected source and displays an error. Retry once it is ready; the application does not automatically send the task to the cloud. Each service handles one job at a time. Cancelling OCR stops and reloads its worker. Cancelling Whisper releases the job slot only after the current decoding call returns; when the service is busy, the desktop transcription queue waits 5 seconds before retrying.

Interface language, the LLM's preferred language, and personal background are saved separately. See the [desktop user guide](APP_README.md#settings-categories) and [LLM guide](LLM_FEATURES.md) for instructions. Cleaning desktop data does not delete records belonging to the three services; manage those within each service project.

## OCR

Import an image in **OCR text recognition** and choose **Recognize text**. Compare the source on the left with the text on the right, edit the text, and copy it. You can switch pages or cancel during recognition; old results are not applied to a new image. Images are limited to 40 MiB and 60 million pixels, with a further service limit of 20,000 pixels on either side.

For background screenshot capture, enable **Automatically receive clipboard images**, keep UFriend running in the background, capture a notice with Windows `Win + Shift + S`, then open the OCR page to review the text. You can also choose **Read clipboard** manually. Automatic reception is off by default and accepts only new images copied after it is enabled.

Manually check Traditional Chinese, English, amounts, URLs, and small text. Model confidence scores do not replace accuracy checks.

## Whisper

In **Meeting notes**, drag in or select audio or video files, choose the language and the action to take after import, then confirm the import. Queue files for sequential transcription or schedule a future local time. Use the play and calendar buttons on each card for files already imported. For Mandarin used in Taiwan, select Traditional Chinese; the service converts recognized Chinese text to Traditional characters without replacing vocabulary with Taiwan-specific terms. This PC service accepts up to 1000 MiB per file. The desktop application can retain larger source files, but the service rejects files over its limit.

Cards display the queue position, scheduled time, or actual transcription progress, and processing continues when you switch pages. Pausing cancels the current inference; requeuing starts again from the beginning. Cancelling a schedule that has not started keeps the file. UFriend must remain open or in the system tray. Jobs that become due while it is closed are queued after the next launch; they do not wake the computer. See [Meeting notes and scheduling](APP_README.md#meeting-notes-and-scheduling) for operation and persistence rules.

Open a card to view or edit its transcript, click a timestamp to seek and play, or export TXT or SRT. Videos use a player on the left and transcript on the right, switching to a vertical layout in narrow windows. Timed transcripts provide a toggleable CC subtitle overlay. No-speech results are marked separately. Errors show the processed range without treating partial results as a successful full-file transcription.

When a timed transcript is available, choose **Export video with subtitles** to save a separate MP4 with subtitles burned into the picture. Export uses FFmpeg and the local CPU. The current Windows release includes FFmpeg; for older or custom builds that do not include it, install the runtime using the [runtime guide](../development/FFMPEG_RUNTIME.md). It does not call a model or require any of the three PC APIs to remain running, and the original file is preserved. See [Subtitled video export](APP_README.md#exporting-video-with-burned-in-subtitles) for progress, cancellation, and saving behavior.

The current feature provides speech transcription, without speaker diarization, meeting summaries, decisions, or action-item extraction. Whisper generates segment timestamps; spot-check their alignment. Switching between Chinese and English, specialized terms, and overlapping speech remain quality limitations.

## LLM chat

Enter a question in **LLM chat** in the sidebar. Enter sends the message, while Shift + Enter inserts a line break. Enter does not send while a Chinese input method is selecting a character. Responses appear incrementally, and text still being generated is marked **Generating · Incomplete**. You can ask follow-up questions, stop generation, and copy successful responses. Choose **Chat history** to open the list and create, switch, rename, or delete conversations. Successful exchanges and drafts are saved separately. Creating or switching conversations stops the current generation, as does deleting the active conversation. Incomplete answers are excluded from history, while the question remains available for retry.

Requests include successfully completed exchanges from the current conversation, the new question, and enabled personal background. They do not attach other conversations, mailbox contents, or recordings. The PC context window is 8,192 tokens, and chat and translation each reserve 4,096 output tokens. If content exceeds the limit, the original text is preserved so you can shorten it or start a new conversation. Each chat message or translation source text is limited to 16,000 characters, but the practical token limit is usually reached earlier. Chat does not provide tool operations, file uploads, or automatic mailbox actions.

## Translation, prompts, and diagnostics

In **Text translation**, select the source and target languages, enter the original text, and choose **Translate**. Source-language detection can be automatic. Available target languages are Traditional Chinese, Simplified Chinese, English, Japanese, Korean, Spanish, French, and German. Copy the translation when complete. Cancelling or changing the source text or languages prevents late results from being applied.

Open **Settings → Prompt settings → Open prompt debugger** to adjust the System instructions and User templates separately for mail analysis, text polishing, LLM chat, and text translation. Defaults come from `GET /v1/prompts` on the current service; changes apply to new requests only after saving. **Reset {task} defaults** (for example, **Reset LLM chat defaults**) removes the local override for the selected task. Mail analysis and polishing still check source text, numbers, and output format.

When an error occurs, first check the code and request ID, then open or export diagnostics from **Settings → Diagnostic logs** or the system log page. The desktop log defaults to `%APPDATA%\UFriend\workspace\diagnostics\events.jsonl`; the PC backend log is `PC-LLM-API/.runtime/requests.log`. Match request IDs across the two to compare processing stages and stop reasons. See the [LLM features and debugging guide](LLM_FEATURES.md) for detailed instructions, template variables, and error handling.

## Development validation

See the [installation and build guide](INSTALL_BUILD.md) for desktop environment preparation and basic checks. `npm run smoke` uses isolated synthetic data and model substitutes and does not need real models. The following tests call running services and do not download, start, or stop them.

| Command | Prerequisites and coverage |
| --- | --- |
| `npm run smoke:llm` | The LLM service must be ready and idle. Tests chat streaming, history, translation, prompts, polishing, language, background, and diagnostics without operating real accounts or the clipboard. The report is written to `.test-results/llm-features/report.json`. |
| `npm run smoke:models` | All three services must be ready and idle, and you must supply `local/test-data/audio/test_audio.mp3`. Tests OCR on synthetic images, media transcription and cancellation, and two-turn chat. The audio file is not included in the repository and needs enough speech and processing time for cancellation and retry checks. The report is written to `.test-results/models/model-smoke-report.json`, with raw output in `local/test-results/integration/`. |
| `npm run smoke:clipboard` | The OCR service must be ready and idle. Temporarily uses the real Windows clipboard with synthetic images to test manual capture, automatic recognition, and disabling, then conditionally restores the original contents. If another application copies new content during the test, that new content is preserved. Reports are written to `.test-results/clipboard/`. |

These tests use separate workspaces. User-supplied audio, test transcripts, and run reports remain in Git-ignored directories. Passing a workflow test does not replace content-quality review; still check OCR text, speech transcripts, and model responses. For API fields, capacity, and cancellation contracts, see the [model interface guide](../../app/models/README.md).
