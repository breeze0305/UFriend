# UFriend 文件

[English](README.md) | [繁體中文](README.zh-TW.md)

[專案首頁](../README.zh-TW.md)

每份專案指南都分別提供英文（`.md`）與繁體中文（`.zh-TW.md`）檔案。可使用文件內的語言連結，或從下表選擇版本。

| 導覽 | English | 繁體中文 |
| --- | --- | --- |
| 功能、快速開始、架構與專案目錄 | [Project README](../README.md) | [專案導覽](../README.zh-TW.md) |
| UGen300 本地 AI 設計目標、硬體資訊與整合進度 | [Designed for ASUS UGen300](../README.md#designed-for-asus-ugen300) | [UGen300 本地 AI 設計](../README.zh-TW.md#以-asus-ugen300-為核心的設計) |

## 使用指南

| 內容 | English | 繁體中文 |
| --- | --- | --- |
| Windows EXE、ZIP 替代方式、環境需求、原始碼設定、測試與打包 | [Installation and build](guides/INSTALL_BUILD.md) | [安裝與編譯](guides/INSTALL_BUILD.zh-TW.md) |
| 郵件、錄音、字幕、OCR、寫作、設定與工作空間恢復 | [User manual](guides/APP_README.md) | [使用手冊](guides/APP_README.zh-TW.md) |
| 另外提供的服務、環境需求、本機端點及連線確認 | [PC model services](guides/PC_MODELS.md) | [PC 模型服務](guides/PC_MODELS.zh-TW.md) |
| 任務預設、供應商需求與資料傳送 | [Model sources](guides/MODEL_SOURCES.md) | [模型來源](guides/MODEL_SOURCES.zh-TW.md) |
| 郵件摘要、分類、對話、翻譯、潤句、提示詞與診斷 | [LLM features and troubleshooting](guides/LLM_FEATURES.md) | [LLM 功能與疑難排解](guides/LLM_FEATURES.zh-TW.md) |
| 自備 Google Desktop OAuth 設定與帳號授權 | [Gmail setup](guides/GMAIL_SETUP_GUIDE.md) | [Gmail 設定](guides/GMAIL_SETUP_GUIDE.zh-TW.md) |

## 開發

| 內容 | English | 繁體中文 |
| --- | --- | --- |
| 介接 API 與任務行為 | [Model adapter contracts](../app/models/README.md) | [模型介接契約](../app/models/README.zh-TW.md) |
| 原生 Windows 剪貼簿輔助程式與建置方式 | [Windows clipboard component](../app/native/README.md) | [Windows 剪貼簿元件](../app/native/README.zh-TW.md) |
| 內建影音元件、選裝方式、開發前置需求及對應原始碼 | [FFmpeg runtime](development/FFMPEG_RUNTIME.md) | [FFmpeg 影音元件](development/FFMPEG_RUNTIME.zh-TW.md) |
| 固定的來源輸入、Windows 交叉編譯、來源打包及執行驗證 | [Build the media runtime](development/MEDIA_RUNTIME_BUILD.md) | [建置影音元件](development/MEDIA_RUNTIME_BUILD.zh-TW.md) |
| 問題回報、修改、驗證與雙語文件規則 | [Contributing](../CONTRIBUTING.md) | [參與貢獻](../CONTRIBUTING.zh-TW.md) |
| 私下回報漏洞與安全邊界 | [Security reporting](../SECURITY.md) | [安全問題回報](../SECURITY.zh-TW.md) |

## 第三方資訊

| 內容 | English | 繁體中文 |
| --- | --- | --- |
| 專案與依賴聲明 | [Third-party software](../THIRD_PARTY_NOTICES.md) | [第三方軟體](../THIRD_PARTY_NOTICES.zh-TW.md) |
| Google 素材來源與使用說明 | [Google brand assets](../app/assets/GOOGLE-BRANDING.md) | [Google 品牌素材](../app/assets/GOOGLE-BRANDING.zh-TW.md) |
| UFriend 自建影音元件的對應原始碼 | [Bundled FFmpeg sources](../scripts/runtime/ffmpeg-bundled/SOURCES.md) | [內建 FFmpeg 來源](../scripts/runtime/ffmpeg-bundled/SOURCES.zh-TW.md) |
| 選裝 Gyan 建置的來源紀錄 | [Optional Gyan runtime](../scripts/runtime/ffmpeg/SOURCES.md) | [選裝 Gyan 影音元件](../scripts/runtime/ffmpeg/SOURCES.zh-TW.md) |
| 內建影音元件的建置說明 | [Bundled runtime README](../scripts/runtime/ffmpeg-bundled/UPSTREAM-README.txt) | [內建影音元件建置說明](../scripts/runtime/ffmpeg-bundled/UPSTREAM-README.zh-TW.txt) |
| 原始 Gyan 建置設定與元件清單 | [Gyan upstream README](../scripts/runtime/ffmpeg/UPSTREAM-README.txt) | [Gyan 上游建置說明](../scripts/runtime/ffmpeg/UPSTREAM-README.zh-TW.txt) |

正式授權條文保留原始內容。英文 `SOURCES.md` 與 `UPSTREAM-README.txt` 影音元件紀錄有固定的雜湊校驗，因此原檔逐位元保留；中文翻譯另外存檔，入口如上表。翻譯清單中的元件識別碼與版本字串維持原樣。

repository 不包含憑證、個人工作資料、模型權重或獨立的 PC 模型服務專案。模型服務請向維護者取得，並依各自的安裝文件設定。
