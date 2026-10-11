# UFriend documentation

[English](README.md) | [繁體中文](README.zh-TW.md)

[Project home](../README.md)

Each project guide has separate English (`.md`) and Traditional Chinese (`.zh-TW.md`) files. Use the language links in the document or choose a version below.

| Overview | English | 繁體中文 |
| --- | --- | --- |
| Features, quick start, architecture, and project layout | [Project README](../README.md) | [專案導覽](../README.zh-TW.md) |

## User guides

| Guide | English | 繁體中文 |
| --- | --- | --- |
| Windows EXE, ZIP alternatives, requirements, source setup, tests, and packaging | [Installation and build](guides/INSTALL_BUILD.md) | [安裝與編譯](guides/INSTALL_BUILD.zh-TW.md) |
| Email, recordings, subtitles, OCR, writing, settings, and workspace recovery | [User manual](guides/APP_README.md) | [使用手冊](guides/APP_README.zh-TW.md) |
| Separately distributed services, requirements, local endpoints, and connection checks | [PC model services](guides/PC_MODELS.md) | [PC 模型服務](guides/PC_MODELS.zh-TW.md) |
| Task defaults, provider requirements, and data transmission | [Model sources](guides/MODEL_SOURCES.md) | [模型來源](guides/MODEL_SOURCES.zh-TW.md) |
| Mail summaries, classification, chat, translation, polishing, prompts, and diagnostics | [LLM features and troubleshooting](guides/LLM_FEATURES.md) | [LLM 功能與疑難排解](guides/LLM_FEATURES.zh-TW.md) |
| Your own Google Desktop OAuth configuration and account authorization | [Gmail setup](guides/GMAIL_SETUP_GUIDE.md) | [Gmail 設定](guides/GMAIL_SETUP_GUIDE.zh-TW.md) |

## Development

| Guide | English | 繁體中文 |
| --- | --- | --- |
| Adapter APIs and task behavior | [Model adapter contracts](../app/models/README.md) | [模型介接契約](../app/models/README.zh-TW.md) |
| Native Windows clipboard helper and build instructions | [Windows clipboard component](../app/native/README.md) | [Windows 剪貼簿元件](../app/native/README.zh-TW.md) |
| Included runtime, optional installation, development prerequisites, and corresponding source | [FFmpeg runtime](development/FFMPEG_RUNTIME.md) | [FFmpeg 影音元件](development/FFMPEG_RUNTIME.zh-TW.md) |
| Pinned inputs, Windows cross compilation, source packaging, and execution verification | [Build the media runtime](development/MEDIA_RUNTIME_BUILD.md) | [建置影音元件](development/MEDIA_RUNTIME_BUILD.zh-TW.md) |
| Bug reports, changes, validation, and bilingual documentation | [Contributing](../CONTRIBUTING.md) | [參與貢獻](../CONTRIBUTING.zh-TW.md) |
| Private vulnerability reports and security boundaries | [Security reporting](../SECURITY.md) | [安全問題回報](../SECURITY.zh-TW.md) |

## Third-party information

| Guide | English | 繁體中文 |
| --- | --- | --- |
| Project and dependency notices | [Third-party software](../THIRD_PARTY_NOTICES.md) | [第三方軟體](../THIRD_PARTY_NOTICES.zh-TW.md) |
| Google asset sources and usage notes | [Google brand assets](../app/assets/GOOGLE-BRANDING.md) | [Google 品牌素材](../app/assets/GOOGLE-BRANDING.zh-TW.md) |
| Corresponding source for the UFriend-built runtime | [Bundled FFmpeg sources](../scripts/runtime/ffmpeg-bundled/SOURCES.md) | [內建 FFmpeg 來源](../scripts/runtime/ffmpeg-bundled/SOURCES.zh-TW.md) |
| Provenance of the optional Gyan build | [Optional Gyan runtime](../scripts/runtime/ffmpeg/SOURCES.md) | [選裝 Gyan 影音元件](../scripts/runtime/ffmpeg/SOURCES.zh-TW.md) |
| Bundled runtime build notes | [Bundled runtime README](../scripts/runtime/ffmpeg-bundled/UPSTREAM-README.txt) | [內建影音元件建置說明](../scripts/runtime/ffmpeg-bundled/UPSTREAM-README.zh-TW.txt) |
| Original Gyan build configuration and component inventory | [Gyan upstream README](../scripts/runtime/ffmpeg/UPSTREAM-README.txt) | [Gyan 上游建置說明](../scripts/runtime/ffmpeg/UPSTREAM-README.zh-TW.txt) |

Official license texts retain their original content. The English `SOURCES.md` and `UPSTREAM-README.txt` runtime records are hash-pinned, so their bytes are preserved; the Chinese translations are separate files linked above. Component identifiers and version strings remain unchanged in the translated inventories.

The repository does not contain credentials, personal workspace data, model weights, or the independent PC model-service projects. Obtain the latter from the maintainer and follow their own installation documentation.
