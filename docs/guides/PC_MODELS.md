# PC 模型服務指南

UFriend 透過本機 API 使用三個獨立模型服務。它們各自管理程式碼、模型、執行環境與啟停，不包含在 UFriend 原始碼或桌面成品中。**目前請向維護者另行取得需要的服務專案，依各自 README 安裝；只取得 UFriend repository 不會同時取得服務。**

本指南對應 PC-LLM-API 0.1.10、PC-OCR-API 0.1.0 與 PC-Whisper-API 0.1.1 的介面與環境。更新服務後，依該專案 README 正常停止及重啟，讓執行中的服務載入新程式。每日郵件整理、會議排程、播放字幕與字幕影片匯出由桌面端處理。

| 能力 | 獨立專案 | 預設端點 | 模型與執行方式 |
| --- | --- | --- | --- |
| 郵件分析、文章潤句、對話、翻譯 | PC-LLM-API | `http://127.0.0.1:8765` | Qwen2.5-1.5B-Instruct Q4_K_M，llama.cpp CUDA |
| OCR 文字識別 | PC-OCR-API | `http://127.0.0.1:8767` | PP-OCRv5 mobile det＋rec，CPU |
| 會議語音轉文字 | PC-Whisper-API | `http://127.0.0.1:8768` | 原始 Whisper Small 多語版，PyTorch CUDA；可選 Base |

端點只提供同一台電腦的 loopback HTTP。UFriend 填寫上表根網址，不加 `/health`、`/v1/llm` 或 `/v1/jobs`。LLM 引擎另用 8766 埠，桌面端仍連接 8765。

## 環境需求

三個服務都需要 Windows x64、Node.js 24 以上，首次安裝需要網路與下載、解壓所需空間。實際固定版本及安裝指令以取得的服務 README 和 lockfile 為準。

| 服務 | 額外環境 | 安裝內容 |
| --- | --- | --- |
| PC-LLM-API | 支援 CUDA 12.4 runtime 的 NVIDIA GPU 與驅動；Windows `tar.exe`。Node 端無額外 npm 依賴，不需 Python。 | setup 下載固定 llama.cpp CUDA runtime 與 GGUF 模型；下載約 1.76 GB，需另留解壓及快取空間。 |
| PC-OCR-API | 可建立 venv 的 64-bit Python 3.10～3.13；使用 CPU，無需 NVIDIA GPU。可用 `UFRIEND_OCR_PYTHON` 指定相容 Python。 | setup 建立專案自己的 venv，安裝固定 Paddle 套件並下載、驗證 OCR 模型；Python 3.14 不適用這組依賴。 |
| PC-Whisper-API | 支援所用 PyTorch CUDA runtime 的 NVIDIA GPU 與驅動，約 10 GB 可用空間；目前固定 PyTorch 2.9.1 cu128。 | setup 下載 Python 3.12.10、PyTorch、OpenAI Whisper、Base／Small 權重與 FFmpeg，不需使用系統 Python；CUDA 不可用時回報未就緒。 |

只需啟動要使用的能力。OCR 可以獨立使用 CPU；LLM 與 Whisper 的上述服務需要 NVIDIA CUDA。UFriend 桌面使用的字幕匯出 FFmpeg 與 Whisper 服務的音訊前處理 FFmpeg 各自管理。

這些服務是 PC 推論實作。Paddle、PyTorch 與 GGUF 權重不能直接當成 UGen300 的 HEF；目前尚未接入 UGen300 實體設備，PC 效能也不能代表裝置效能。

## 安裝、啟動與連線

1. 另行取得所需的服務專案，在各自目錄依 README 完成首次安裝；目前三個服務均提供 `npm run setup`。這是安裝步驟，不需要在每次啟動前重跑。
2. 在該服務目錄使用 `Start API.cmd` 或其 README 指定的啟動命令。等待模型載入完成；啟動器返回不代表已就緒。
3. 開啟 UFriend → 設定 → 模型與運算 → 本地，連線方式選 PC API。新安裝預設使用此連線方式；舊設定會保留原本選擇。
4. 核對上表端點，保存後逐一按「測試連線」。要使用的服務需回報 API v1 與模型已就緒，再於各次工作選「本地」。來源不由設定頁全域切換，詳見[模型來源指南](MODEL_SOURCES.md)。
5. 使用後依各服務 README 停止，可用其 `Stop API.cmd`。結束 UFriend 不會停止獨立服務。

請在各服務自己的目錄執行命令，不要在 UFriend 根目錄執行服務的 setup 或停止命令。已有服務時，先用其 `npm run health` 或 UFriend「測試連線」確認狀態；修復或重新安裝前先正常停止該服務。

服務未啟動、載入中或端點錯誤時，對應功能會保留來源並顯示錯誤；就緒後可重試，不會自動改送雲端。每個服務一次處理一個工作。OCR 取消會停止並重新載入 worker；Whisper 取消需等當次解碼返回才釋放工作槽，桌面轉錄佇列遇到忙碌會等待 5 秒再重試。

介面語言、LLM 常用語言及個人背景各自保存；操作見[桌面使用說明](APP_README.md#設定分類)與 [LLM 指南](LLM_FEATURES.md)。桌面資料清理不會刪除三個服務的紀錄，請在各服務專案內管理。

## OCR

在「OCR 文字識別」匯入圖片，按「開始識別」。可核對左側來源、編輯右側文字並複製。辨識期間可切頁或取消；新圖片不會套用舊結果。圖片上限 40 MiB、6,000 萬像素，服務另限制單邊 20,000 像素。

背景截圖流程：勾選「自動接收剪貼簿圖片」，保持 UFriend 在背景執行，使用 Windows `Win + Shift + S` 擷取公告，再開 OCR 頁核對文字。也可手動按「讀取剪貼簿」。自動接收預設關閉，只接收啟用後的新圖片。

繁中、英文、金額、網址與小字都應人工核對；模型輸出的信心值不能代替正確性檢查。

## Whisper

在「會議紀錄」拖入或選擇音訊／影片，先選語言與匯入後的動作，再確認匯入。可依序排隊轉錄，或指定未來的本機時間；已匯入檔案由卡片的播放／日曆按鈕操作。台灣中文可選繁體中文；服務將中文辨識文字轉為繁體字，不替換成臺灣詞彙。此 PC 服務每檔上限 1000 MiB；桌面可保留更大的來源，但服務會拒絕超限檔案。

卡片顯示佇列位置、指定時間或實際轉錄進度，切頁後繼續執行。暫停會取消本次推論，再加入佇列從頭開始；取消尚未開始的排程保留檔案。UFriend 需開啟或留在系統匣，關閉期間到期的工作會在下次開啟後排隊；不會喚醒電腦。操作與保存規則見[會議紀錄與排程](APP_README.md#會議紀錄與排程)。

點卡片查看逐字稿、點時間跳轉後播放、匯出 TXT 或 SRT，也能編輯文字。影片採左側播放／右側逐字稿，窄視窗改上下排列；帶時間的逐字稿提供可切換的 CC 浮動字幕。無語音會獨立標示；錯誤顯示已處理範圍，不把部分結果當成全檔成功。

已有帶時間的逐字稿時，可按「匯出含字幕影片」另存 MP4，把字幕燒錄到畫面上。匯出使用已依 [runtime 指南](../development/FFMPEG_RUNTIME.md)安裝的 FFmpeg 與本機 CPU，不呼叫模型，也不需要三個 PC API 保持啟動；原檔保留。進度、取消及保存方式見[字幕影片匯出](APP_README.md#匯出含字幕影片)。

目前提供語音轉錄，不包含說話者分離、會議摘要、決議或待辦抽取。段落時間由 Whisper 產生，仍需抽查對齊；中英切換、專有名詞及重疊發言是品質限制。

## LLM 對話

左側「LLM 對話」輸入問題。Enter 傳送、Shift＋Enter 換行；中文輸入法選字中的 Enter 不傳送。回覆逐段顯示，生成中的內容標為「尚未完成」。可追問、停止與複製成功回覆，按「聊天紀錄」開啟清單並新增、切換、重新命名或刪除對話。各段成功問答與草稿分開保存；新增或切換對話會停止目前生成，刪除目前對話也會停止。未完成答案不加入歷史，問題會保留供重試。

傳送目前這段對話成功完成的問答、新問題與啟用的個人背景，不附加其他對話、信箱內容或錄音。PC context 為 8,192 tokens，聊天與翻譯各預留 4,096 output tokens；內容超限時保留原文，可縮短或新增對話。聊天每則訊息／翻譯原文最多 16,000 字元，但實際 token 容量通常更早達到。聊天沒有工具操作、檔案上傳或自動操作信箱。

## 翻譯、Prompt 與診斷

在「文字翻譯」選來源與目標語言，輸入原文後按「開始翻譯」。來源可自動偵測；目標可選繁中、簡中、英、日、韓、西、法、德。完成後可複製譯文；取消或修改原文／語言不會套用晚到結果。

設定 → Prompt 設定 →「開啟 Prompt 除錯」，可分別調整郵件分析、文章潤句、LLM 對話、文字翻譯的 System 指示與 User 模板。預設內容由目前服務的 `GET /v1/prompts` 取得，保存後才用於新請求；「恢復預設」移除該任務的本機覆寫。郵件／潤句仍有原文、數字及輸出格式檢查。

遇到錯誤，先核對 code 與 request ID，再從設定 → 診斷紀錄或系統紀錄頁開啟／匯出診斷。桌面預設在 `%APPDATA%\UFriend\workspace\diagnostics\events.jsonl`；PC 後端在 `PC-LLM-API/.runtime/requests.log`。兩邊以 request ID 對照階段及停止原因。詳細操作、模板變數與錯誤處理見[LLM 功能與除錯指南](LLM_FEATURES.md)。

## 開發驗證

桌面環境準備與基本檢查見[安裝與編譯指南](INSTALL_BUILD.md)。`npm run smoke` 使用隔離合成資料與模型替身，不需要真模型；下列測試則會呼叫已啟動的服務，不負責下載或啟停服務。

| 命令 | 前提與測試範圍 |
| --- | --- |
| `npm run smoke:llm` | LLM 服務已就緒且閒置；測試對話串流、歷史、翻譯、Prompt、潤句、語言、背景與診斷，不操作真實帳號或剪貼簿。報告在 `.test-results/llm-features/report.json`。 |
| `npm run smoke:models` | 三個服務均已就緒且閒置，並自行準備 `local/test-data/audio/test_audio.mp3`；測試合成圖片 OCR、影音轉錄與取消、兩輪對話。音檔不隨 repository 提供，需包含足夠語音及處理時間供取消／重試檢查。報告在 `.test-results/models/model-smoke-report.json`，原始輸出在 `local/test-results/integration/`。 |
| `npm run smoke:clipboard` | OCR 服務已就緒且閒置；以合成圖片短暫操作真正 Windows 剪貼簿，測試手動擷取、自動辨識與停用，之後有條件恢復原內容；途中有外部新複製時保留新內容。報告在 `.test-results/clipboard/`。 |

這些測試使用獨立工作空間。自行提供的音檔、測試逐字稿與執行報告保留在 Git 排除的目錄；流程通過不能代替內容品質驗收，仍需核對 OCR 文字、語音逐字稿及模型回答。API 欄位、容量與取消契約見[模型介面說明](../../app/models/README.md)。
