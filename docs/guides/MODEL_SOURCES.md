# Choose local or cloud processing for each task

[English](MODEL_SOURCES.md) | [繁體中文](MODEL_SOURCES.zh-TW.md)

UFriend separates model sources into Local and Cloud. Settings stores the connection method, endpoints, models, parameters, and defaults for three types of work. You can still choose a source for each task. Switching the Local models/Cloud models tab in Settings only changes the configuration view; it does not change other tasks' sources.

## Setting default sources

In Settings → Models and compute, both the Local models and Cloud models tabs have three “Use by default” switches: text LLM, OCR, and speech transcription. These defaults are independent, and each type always has one default. All three default to Local on first use. A switch saves immediately without saving any unsubmitted endpoint or API key form values beside it.

Opening the home page, email, chat, translation, writing polish, OCR, or a new meeting import dialog resets the preselected source to that type's default. For example, with text set to Local by default, temporarily choosing Cloud on the translation page does not persist after leaving and returning; Local is selected again. Changing pages or defaults does not resend or reassign running jobs. The UI separately indicates the active source, and completed results retain their original source. Schedules and retries for an imported meeting use the source saved with that meeting.

Daily automatic email organization uses the default text LLM source when it starts. Automatic OCR for clipboard capture or image import continues to use Local. The OCR default applies to manual recognition on the feature page.

## Configuring connections

Open Settings → Models and compute. For a PC API connection, follow Local models → Local backend → PC local services.

### Local models

- **PC local services (PC API):** Save the three endpoints for LLM, OCR, and Whisper. Their defaults are `http://127.0.0.1:8765`, `http://127.0.0.1:8767`, and `http://127.0.0.1:8768`, respectively. Only local loopback HTTP is accepted. Install and start each service separately; see the [PC models guide](PC_MODELS.md).
- **UGen300:** This is a local connection method, but physical hardware is not integrated yet. Timed scheduling in the device pool is for development verification only. Choosing it does not substitute PC API or cloud inference.

A new installation selects “PC local services” as its default “Local backend.”

### Cloud models

OpenAI-compatible APIs are supported. Enter the API base URL, key, and model names for the three features as provided by your provider. No models are preselected.

| Field | Purpose |
| --- | --- |
| API endpoint | The API base URL, including any provider-required path such as `/v1`. Do not append `/chat/completions` or `/audio/transcriptions`. |
| Text and chat model | Email analysis, chat, translation, and writing polish. |
| Image text model | A Chat Completions model that supports image input. |
| Speech transcription model | A model supporting Audio Transcriptions, `verbose_json`, and segment timestamps. |
| Text generation temperature | Optional. Leave blank to use the service default. If supplied, the value must be 0–2 and the selected model must support the parameter. |
| API Key | Stored using Electron `safeStorage`. Leave blank to retain the existing key, or remove it separately. |

API endpoints accept HTTPS. A local compatible test service may use loopback HTTP. An endpoint must not contain embedded credentials, query parameters, or a fragment. Testing the connection reads the provider's model list to confirm that the specified models are visible, without running paid generation. Listing a model does not prove compatibility with every task format.

Providers and models may support only some features. Text and OCR use `/chat/completions`; chat receives SSE streams, while OCR recognizes text from image input. Speech uses `/audio/transcriptions`. Models that return only plain text without segment timestamps cannot currently create meeting transcripts. Use the provider's documentation to choose compatible models.

Protocol references: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Audio Transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create). Cloud OCR images are limited to 20 MiB. Meeting audio can be up to 12 hours long and is split and compressed first so that each chunk is below the API's 25 MB upload limit. See [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text).

## Choosing a source in a task

| Feature | Selection and persistence |
| --- | --- |
| Meeting notes | Choose a source when importing audio or video; it is saved with each meeting. Importing alone does not upload the media immediately. Queuing or scheduling it uses that meeting's saved source. |
| Email organization | Opening the page preselects the default text LLM source. Summarization and categorization within the batch use the same source. |
| OCR | Choose the source before starting manual recognition. With automatic recognition enabled, clipboard capture and image import always use Local while preserving the manual source selection. Completed results show the source actually used. |
| Chat | Choose the source for this turn in the input area. You can change it for a new turn; completed messages retain the source used at the time. |
| Translation and writing polish | Choose the source independently in each feature's execution area. |

Temporary feature-page choices last only for that visit. Once a job starts, its actual source is saved. Meetings retain their source through scheduling, retries, and app restarts. To change a meeting that is being transcribed or is scheduled, pause it first, change its source, then start again.

Changing an endpoint or model parameters cancels only active jobs for the affected source and model type. Completed results retain the source actually used. Changing the next job does not rewrite previous results' sources. If a source is unavailable or a request fails, the app preserves the original content and shows the reason without switching sources automatically.

## Where your data is sent

With Local selected, model input goes only to the configured local service. With Cloud selected, the required content goes to the service endpoint you entered:

- Meetings: audio is extracted locally and uploaded in chunks. Video frames are not uploaded for transcription. Temporary audio generated for the job is cleaned up after processing or cancellation.
- Chat: includes the current question and history of the active conversation. Switching to Cloud therefore also sends earlier locally processed content in that conversation as context. Start a new conversation when you need to keep content separate.
- Email: summarization sends that email's text, sender and recipient fields, and reference time, without Gmail authorization tokens or attachments. Categorization receives only the resulting summary, without the original email, personal background, or a custom prompt.
- OCR, translation, and writing polish: send the selected image or entered text, respectively. When personal background is enabled, relevant LLM tasks also include the corresponding background fields.

Video subtitle export runs locally using FFmpeg and is independent of the transcription source. The current Windows EXE includes FFmpeg. Only older or self-built versions without the media runtime need the optional installation: open Settings → General → Media runtime to download and install it, or select an extracted official package. An optional installation is stored in the user data directory and remains available after restarts and updates. Cloud speech audio preprocessing also needs this desktop media runtime. The local PC-Whisper-API service manages its own audio preprocessing FFmpeg separately; the desktop's bundled or optional runtime does not replace it. See the [FFmpeg runtime guide](../development/FFMPEG_RUNTIME.md). Cloud service fees, quotas, and data retention policies are determined by the provider.

[Back to the user guide](APP_README.md) · [Model interface contract](../../app/models/README.md)
