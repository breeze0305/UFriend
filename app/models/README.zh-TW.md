# UFriend 模型接入介面

[English](README.md) | [繁體中文](README.zh-TW.md)

UFriend 0.1.41 支援獨立 PC API 與 OpenAI 相容雲端 API；桌面程式不下載、載入或啟動模型。`adapters.cjs` 定義 registry，`main.cjs` 註冊各來源的 LLM、OCR 與語音 adapter。本地對應服務為 `PC-LLM-API` 0.1.10、`PC-OCR-API` 0.1.0 與 `PC-Whisper-API` 0.1.1，均需另行取得原始碼並依各自 README 安裝；它們不是本 repository 的子目錄或隨附模型。環境及端點見 [PC 模型指南](../../docs/guides/PC_MODELS.zh-TW.md)。

桌面設定的「模型與運算」保存本地／雲端連線配置；實際來源在各次任務選擇。`ModelAdapters` 以來源與模型種類註冊，`run(kind,{source,task,input,signal,...})` 僅呼叫指定來源，不降級到另一類。「一般」提供常用語言，「個人資訊」提供模型背景；操作見[模型來源指南](../../docs/guides/MODEL_SOURCES.zh-TW.md)。

## 已接入與保留的邊界

| 設定／能力 | 現況 |
| --- | --- |
| `source: 'local'`、`localBackend: 'pc-api'` | `devLlm.endpoint` 預設 8765（mail／polish／chat／translate）、`devOcr.endpoint` 預設 8767、`devWhisper.endpoint` 預設 8768，均為 `http://127.0.0.1`。 |
| `source: 'local'`、`localBackend: 'ugen300'` | 尚未接入實體設備或 Hailo SDK，回報 `MODEL_NOT_CONFIGURED`。 |
| `source: 'cloud'` | `api` 保存 endpoint、model、ocrModel、transcriptionModel、temperature；API Key 由憑證庫提供給 cloud adapter，支援 OpenAI 相容協議。 |
| 本地 OCR、Whisper | media adapter 串流上傳工作空間管理的檔案，再查詢工作進度、驗證結果；取消發 DELETE。 |

`status().sources.local/cloud` 分別回報各 kind 的配置狀態；`isConfigured()` 不代表服務已就緒。本地「測試連線」呼叫 `GET /health`，核對 API v1 與 `ready: true`；雲端讀取 `GET /models` 確認指定模型可見。全域 `compute` 僅在舊資料初始化時遷移，新的設定 API 不接受該欄位；缺少任務來源的舊資料以本地處理。

`settings.modelDefaults` 的 llm／ocr／whisper 分別保存 local 或 cloud。功能頁的臨時選擇在每次開啟時回到預設，改預設不取消正在執行的工作。會議 `recording.source` 隨匯入、排程、重試及重啟保存。每次執行固定 request.source，controller 同時記錄 kind/source，配置變更只取消受影響的執行中工作。模型結果的 `meta.source` 由本機執行來源寫入，不信任遠端回傳的來源名稱。

## PC API 呼叫與資料驗證

本節的 transport、context token 容量、服務錯誤規則與逾時數值描述 PC 服務。桌面端的任務輸入與結果驗證適用於兩種來源；雲端的模型容量依供應商與所選模型而定。

LLM 健康回應若提供 `capabilities`，須為字串陣列且至少含 `mail`、`polish`、`chat` 或 `translate`；只有 OCR／Whisper 能力的服務不會通過 LLM 連線測試。舊版 API v1 未提供此欄位仍可使用。LLM 與 media JSON 回應皆驗證完整 UTF-8，損壞的位元組回報 `MODEL_INVALID_OUTPUT`。翻譯與潤句若明示 `truncated: true`、`complete: false` 或長度上限完成原因，回報 `MODEL_OUTPUT_LIMIT`，不保存為成功結果。

Adapter 實作入口是 `run({ task, input, signal, onProgress, onDelta })`。PC transport 一般送出 `POST /v1/llm`，JSON 為 `{task, input, prompt?, context?}`；自訂 `prompt` 僅含 `system`／`user`，每項任務獨立保存，預設來自 `GET /v1/prompts`。有 `onDelta` 的 chat 使用 `POST /v1/llm/stream`，解析 SSE 的 delta／done／error；只有完成且符合 API v1 的結果可保存。端點只允許 loopback HTTP，禁止帳密、query、fragment 與 HTTP redirect；目前服務實際綁定 IPv4 `127.0.0.1`，使用預設位址最直接。健康檢查 5 秒、推論請求 180 秒逾時，一般 JSON 回應最多 1 MiB、SSE 傳輸最多 2 MiB。

- `polish`：`input` 包含 `text`、`use`（`document`／`email`／`message`）、`tone`（`polite`／`casual`／`formal`）；回傳非空 `text` 與可選 `meta`。core 保存前再驗證文字及輸入版本。
- `chat`：`input.messages` 僅含目前聊天室的 `user`／`assistant`，由 user 開始且結尾，最多 31 筆、單筆 16,000 字元、合計 64,000 字元。真正可用長度還受 8,192-token context 限制；服務精確計算含提示及 4,096-token 輸出預留，超限回 413，不截斷歷史。回覆最多 16,000 字元；增量僅存在記憶體，以獨立 IPC 事件更新一個未完成氣泡。只保存完成的問答配對，取消或失敗保留問題。
- `translate`：`input` 包含 `text`、`sourceLanguage`、`targetLanguage`；來源可為 `auto`，目標為 zh-TW／zh-CN／en／ja／ko／es／fr／de。原文及回覆各最多 16,000 字元；context 8,192、輸出預留 4,096 tokens，同時受實際模型容量限制。來源、語言或提示變更會拒絕舊工作晚到結果。
- `mail`：每次 `input.messages` 恰有一封，包含 `id`、`subject`、`body`、`sender`、`senderEmail`、`date`、`to`／`cc` 地址陣列與 `contentContext`，另有 `recipient` 與固定的批次 `referenceTime`。`contentContext` 只包含 `attachmentCount`、`unreadImageCount`、`imageTextUnavailable`、`textLimited` 等可用性資訊；不傳 OAuth Token、API Key、BCC、圖片／附件檔案或整個 workspace。
- 預設一般 `mail` 送給模型的原文行為 `[id,field,quoteDepth,text]`，`field` 區分 subject／body；引用層級取正文原始行開頭 0～3 個空白後的 `>`，拆句／分塊仍保留來源層級。0 不宣告新舊，原文與引用 ID 不改寫。這是 PC 0.1.8 與桌面雲端 adapter 的內部輸入表示，自訂模板維持原有物件行格式。
- `mail-select`／`mail-compose`：PC 0.1.6 新增、0.1.7 擴充的內部任務，共用 `{mail:{id,subject,date,sender,to,cc},referenceTime,recipient,lines:[[id,text],...]}`。select 回傳 `{evidenceIds}`，接受本次候選中存在、互不重複的 0～64 個 ID；compose 回傳 `{summary,reason,priority,evidenceIds}`，引用仍為 1～8 個 ID，priority 只接受 0／1／2。PC 選文模型內部逐行決定是否保留，再轉成 ID 陣列。使用固定提示，不帶自訂 prompt／context，不列入公開 Prompt 設定；完整新版流程需 PC-LLM-API 0.1.7，無須重新下載模型。
- 郵件回應為 `analyses` 一筆，ID 必須與請求相同；公用 API 相容驗證允許非空 `summary`／`reason` 各不超過 2,000 字元，預設生成摘要需少於 1,000 字元、理由少於 160 字元；`priority` 只能是整數 0／1／2；`evidence` 須為 1～8 筆非空、最多 1,000 字元的主旨／內文原文片段。PC 一般 mail 最多回傳 4 個引用，分段彙整最多 8 個；所有引用都必須對回來源。
- `mail-classify`：只接收 `input: {summary}`，非空摘要最多 2,000 字元，使用固定提示且不附加 prompt／context。回傳 `{category}`，只接受 work／meeting／finance／account／promotion／personal／other 七個 ID；缺少、無效與未完整結果不能當成「其他」。PC 0.1.5 新增此能力，舊服務拒絕分類時顯示升級提示。
- PC 0.1.8 與桌面雲端分類使用相同的固定類別說明及五個合成反例，說明工作往來、交易憑證、課程行銷等邊界；由模型判斷整份摘要，不以程式關鍵字指定分類，也不把原信或個人背景加進分類請求。
- `meta` 可提供服務與模型資訊。業務結果白名單保留 `model`、`backend`，並另記本機確認的 `source`；長信成功結果可另保存 `processingMode: 'segmented'` 與 1～128 的整數 `chunkCount`。PC 診斷紀錄另保存合法 request ID、context、token 用量、finish reason 與耗時，不保存請求原文或回覆全文。

穩定的優先分級語意：0 為本人今天有明確截止時刻或明示立即處理；1 為本人今天有一般待辦；2 為今天無待辦或未來才需處理。本人責任、取消與否定條件應先於時間判斷；寄信日期是今天或只是副本，都不足以單獨決定分級。主題類別、本人寄出或缺少要求字詞也不能單獨把分級改為 2。來源引用只能證明字串存在，不保證摘要或語意分類正確。

服務端錯誤碼包括 `MODEL_INVALID_REQUEST`、`MODEL_INPUT_TOO_LONG`、`MODEL_REVIEW_REQUIRED`、`MODEL_API_UNAVAILABLE`、`MODEL_API_BUSY`、`MODEL_API_TIMEOUT`、`MODEL_INVALID_OUTPUT`、`MODEL_OUTPUT_LIMIT`；client 另核對 `MODEL_API_INCOMPATIBLE`，未收到完整串流則回報 `MODEL_STREAM_INTERRUPTED`。輸出上限或斷線都不能將部分回答當成成功。`MODEL_REVIEW_REQUIRED` 表示郵件含明確的模型控制文字，未進行推論，需人工確認；它是保守規則，可能拒絕正常討論此類內容的信件，並非完整的提示注入防護。

## 工作生命週期

LLM 請求可附 `context: {preferredLanguage?, profile?}`。`preferredLanguage` 只在 chat 使用，為 zh-TW／zh-CN／en／ja／ko／es／fr／de；profile 只用於 chat、polish、一般 mail 全文摘要，包含已啟用且非空的 name、phone、personalEmail、workEmail、company、jobTitle、notes。enabled 留在本機，translate 與三種內部郵件任務不送 context。profile 各欄長度上限依序為 120／80／254／254／120／120／2000 個 JavaScript 字元；桌面另限制 JSON 編碼長度，後端 context 上限 5000。背景以 JSON 資料加入已展開的 prompt，不能改寫原始郵件收件人、引文或輸出驗證；全文不寫入診斷。

設定保存時先驗證再原子套用。更改語言只取消 chat；更改有效背景會取消 chat、polish、mail。值相同，或只編輯已停用背景，均不取消現有工作。新設定只影響之後請求；既有對話中的個人資料不會因停用而刪除。

`mail.analyze` 以 `categorize:true` 逐封整理當下收件匣，包含已讀與 done；主按鈕預設 `onlyChanged:true`，單封 `ids:[id]` 可配 `onlyChanged:false` 完整重算。core 原有未分類分析入口保留相容性。批次保存 `processed`／`total`／`failed`／`skipped`／`unchanged`；processed 包含成功、失敗與略過，不能當成成功數。running 的 phase 為 summary、chunking、merging 或 classification。分段透過 `onProgress(undefined,{stage:'mail-chunks'|'mail-merge',chunkIndex,chunkTotal})` 回報，chunkIndex 是已完成段數；core 只接受當前郵件摘要階段的合法進度，結束、取消或換信即清除。未配置模型會提前結束；單封失敗繼續下一封。

桌面 core 在兩種來源的摘要請求前，先以 `splitMailThread(body,{firstOnly:true})` 取最上方正文；可辨識的引用／轉寄邊界後一律不交給生成、原文重點、品質檢查或容量補救。帶 Re／Fw／Fwd 或已識別中文回覆、轉寄前綴的主旨也從分析副本排除；若沒有剩餘文字，不用舊主旨補造事件。普通新信主旨保留。圖片內容狀態也只計目前 HTML 區域，附件狀態仍取原信。再使用 `mail-analysis-input.cjs` 將主旨／內文中的 HTTP(S) 與明確 www 網址替換為 `【網址】`；只將精簡文字交給 adapter，原文位置映射不離開桌面。回覆先針對精簡輸入驗證，再將引文還原並針對所選正文重新驗證。同一簡化引文對應不同網址時，僅在所有位置均包含程式產生的網址標記，而且去除網址後的連續原文片段序列一致時，改用共同文字片段。原生標記與生成標記混合的歧義仍拒絕。不能核對的引文不能套用；不串接網址兩側，仍遵守每段 1,000 字元及共 8 段上限。API v1 的 mail／analyses 欄位保持相容。所有郵件使用 v9 fingerprint，舊 v1～v8 摘要下次整理重算；內容比對與 fingerprint 仍採原始郵件，避免不同網址被視為同一封未變動內容。

兩種 adapter 共用 `mail-processing.cjs`：每封先執行正常 mail 簡短主題摘要，只在 `MODEL_INPUT_TOO_LONG`、`MODEL_OUTPUT_LIMIT` 或重複生成時進入分段。逐段以 mail-select 選原文，另保留有限的日期、金額、狀態、條件與鄰近上下文；候選過多或彙整輸入仍超限時，再對候選原文選取，最後以 mail-compose 統一生成本次正文的主題短語、分級與理由，將引用 ID 還原為原文並回傳既有 analyses 格式。中間不生成段落摘要，且每次工作固定來源、端點、模型、金鑰及設定，不在失敗時切換來源。

分段最多 128 段、192 次內部模型呼叫及 6 輪縮減，特殊流程總時限 10 分鐘（不含首次正常摘要請求），單次請求仍受自己的逾時限制。分段選文或彙整再遇輸入／輸出容量上限時，可從可核對的來源建立明確標為「原文摘錄」的結果，並要求人工核對分級；它不是模型已完成的生成摘要。取消、逾時、格式錯誤及引文驗證失敗仍不能發布結果。原文保留與補救皆有上限，不能保證完整語意或所有長信都能完成。

PC 0.1.7 預設 mail 與 mail-compose 預留 1,536 output tokens，摘要需少於 1,000 字元、理由少於 160 字元；mail-select 預留 1,024 tokens，每次可選 0～64 行，compose 引用為 1～8 行。自訂 Prompt 的一般 mail 保留 512-token 輸出契約，公用結果格式保持相容；chat／translate 各預留 4,096，polish／mail-classify 各 512。全部提示、欄位與輸出預算都計入 8,192-token context。

core 透過 `mail-quality.cjs` 保存 `analysis.sourceFacts`：最多 32 段原文，每段最多 1,000 字元，畫面先顯示 3 段，其餘可展開。這些片段不能由模型補寫，也不代表摘要獲得完整語意驗證。`analysis.quality.sourceFactsTruncated` 由桌面標記原文重點的擷取容量不足，顯示查看原信提示；此旗標本身不否定生成摘要或改變分級。`analysis.quality` 保存有限品質檢查、內容可用性與 `priorityReview`。摘要與理由分開核對新增幣別、部分數字／代碼／時長、附件與明確條件矛盾；只有摘要本身的硬性衝突才替換摘要，理由衝突只要求核對分級。細節覆蓋不足、引文用詞差異及沒有重述無需行動／已收到等訊號只保留 diagnostics，不單獨替換摘要或要求核對分級。每次重算衝突所屬欄位，既有 issues 不會把理由錯誤升級成摘要錯誤；容量補救的原文摘錄、文字不足且圖片／附件未讀的保守處理及待核對狀態仍保留。任何已知未辨識圖片都可產生 `imageTextUnavailable` 提示，不限於文字不足 80 字的郵件；有附件時另以 `attachmentTextUnavailable` 提示附件尚未讀取、僅整理郵件文字。檢查無提示不代表摘要正確。

先保存有效 summary、summaryFingerprint 與 categoryStatus:pending，再將同一最終摘要送給 mail-classify；標為「原文摘錄」時也只傳送這份最終文字，不另提供原信。成功保存 category、categoryMeta、fingerprint 與 categoryStatus:done；失敗保存 categoryStatus:error／categoryError，重試可重用同 fingerprint 的摘要。v9 fingerprint 包含原始文字、寄件者地址、附件／圖片內容狀態、收件者身分、來源及有效模型／Prompt／背景設定，並加入台北日期；同日未變可略過，隔日整理重新計算當天待辦。一個批次固定開始時的 referenceTime，跨午夜仍沿用同一日期。金鑰、已讀／標籤／人工分級不納入快取。

結果套用前確認郵件仍在收件匣，內容、日期、寄件者姓名／地址、To／CC、圖片／附件狀態、本人地址與有效整理設定未變。模型結果保存於 `mail.analysis`；只有非人工分級且沒有 `quality.priorityReview` 才套用模型分級。有疑慮時顯示「待核對」，不把模型的 0／1／2 當成已確認結果。`prioritySource: 'manual'`（包含人工清除分級）保持優先，舊資料中已存在的 0／1／2 也遷移為人工分級。

待辦檢查以子句排除已辨識的「請勿回覆」與選用查閱／客服條件，後續仍有交辦、期限或第二項動作時保留核對依據。這只會攔下缺乏依據的模型分級，不指定新的分級；仍無法涵蓋所有自然語言條件。

`mail-scheduler.cjs` 依 settings.mailSchedule 的 enabled／HH:mm 每日一次，先持久保存 mailScheduleState.lastScheduledDate 再執行同步與整理；使用電腦本地日期，忙碌延後，恢復時只追補當天，失敗不當日無限重試。自動工作捕捉開始時的 llm 預設來源，與手動整理互斥；測試模式不啟動計時器。

取消必須透過 `signal` 中止實際 HTTP／推論工作，不能只停止畫面計時。core 亦防止忽略取消的 adapter 用晚到結果覆蓋資料；實際更改連線配置只取消相同來源與受影響模型種類的工作。潤句輸入、用途或語氣變動即清空舊輸出；無變更的自動保存不取消工作。App 重啟會把上次未完成的郵件批次改成已中斷，保留先前結果。

模型回傳只是資料，不能觸發寄信、刪除郵件、改 Gmail 標籤、建立日曆或執行程式。沒有自動上傳雲端或失敗降級。服務端格式檢查、原文引用及潤句數字／占位符檢查是防線，不能取代對摘要、金額、人名與否定語意的核對。

## OCR 與 Whisper 工作 API

`local-media-api.cjs` 呼叫各服務的 `GET /health`，核對 API v1、ready、model／backend 與對應能力。`POST /v1/jobs` 傳送原始檔案 bytes，帶 `X-UFriend-Client: 1`；不將路徑或整個 workspace 傳給服務。HTTP 202 回 `jobId`，以 `GET /v1/jobs/{id}` 查詢，`DELETE /v1/jobs/{id}` 取消。

狀態為 queued／running／completed／failed／cancelled，progress 0～1。桌面完成驗證前最多顯示 99%；Whisper 額外回 processedSeconds／durationSeconds，長錄音失敗會保留範圍但不套用完整逐字稿。

- OCR 傳 PNG／JPEG，40 MiB 上限。結果是 `{text, regions: [{text, confidence, box}], meta}`，每個 box 為四組 `[x,y]`。空文字與空 regions 是合法無字結果。服務限制 6,000 萬像素與單邊 20,000 像素；App 匯入圖片會先轉為 PNG。
- Whisper 傳影音 bytes，1000 MiB 上限，帶 `X-UFriend-Language` 與 URL 編碼 basename。結果是 `{segments: [{start,end,text}], language, duration, meta}`。時間不得為負、倒序或超出檔長，空 segments 表示無語音。
- media 回應上限 12 MiB；健康檢查 5 秒、單次請求 30 秒、上傳 10 分鐘、總處理 OCR 180 秒／Whisper 2 小時。取消清理使用獨立 5 秒請求。逾時、忙碌、格式錯誤與未就緒使用安全訊息，不顯示服務內部路徑。
- 切換端點只取消對應能力；換圖、修改文字、刪除錄音或改語言會阻止晚到結果覆蓋新狀態。結束 App 會取消仍在執行的模型工作並等待有界清理。

## 雲端 API

`cloud-api.cjs` 依 kind 註冊三個 adapter。每次工作先固定當時的端點、模型、金鑰與參數；禁止 redirect，不將供應商的原始錯誤內文顯示或寫入診斷。LLM 與 OCR 使用 Chat Completions，請求 `store: false`；公開文字任務保留自訂提示及既有結果驗證，郵件分段選文、彙整與分類沿用固定提示且不附加個人背景。長信使用相同共用流程；實際容量仍依供應商與模型而定。對話必須收到成功結束原因與完整 `[DONE]` 才可保存。

OCR 傳送 PNG、JPEG 或 WebP 圖片，最大 20 MiB；不生成虛構座標。`cloud-audio.cjs` 使用本機 FFmpeg 抽取 mono 16 kHz MP3，依分段清單的實際起點合併時間戳，每段小於 25 MB，總長上限 12 小時。Transcriptions 必須提供 `verbose_json`、duration 與 segments，缺少時間戳時回報不相容，不估算字幕。

成功、失敗與取消皆等待暫存音訊清理。結束程式時再次確認清理結果；若本次暫存仍無法移除，保留程式並顯示錯誤。API 欄位、相容條件與資料傳送範圍見[模型來源指南](../../docs/guides/MODEL_SOURCES.zh-TW.md)。

## 後續 UGen300

優先保留相同 API v1，在獨立本機服務內把 PC llama.cpp backend 換成經驗證的 UGen300／Hailo backend。桌面 UI、保存格式、進度及取消邊界可沿用；未來產品仍需明確提供正式的裝置模式接入，不能把現在的「PC 測試 API」標示當作已接硬體。模型載入、HEF 相容性、裝置 ID、拔除與資源釋放由硬體服務管理；PC GGUF 不是可直接移植的 HEF。

1. 接入一個模型能力後，使用固定資料完成品質與取消／失敗驗證，再擴充其他能力。
2. OCR 是文字偵測、裁切排序、辨識與合併的一個邏輯 worker，可管理兩個網路；不要求只是一個模型檔。
3. Whisper 音訊抽取與格式前處理留在獨立服務內，桌面 adapter 傳送原始影音 bytes 並接收帶起訖時間的段落；進度來自服務已處理的音訊或 backend 事件。後續硬體服務沿用相同邊界，不在桌面重複維護前處理流程。
4. `services/model-pool.cjs` 現在是明示的計時調度模擬。實體裝置接入後須以 SDK 完成／失敗事件與真實資源生命週期取代計時假設，模擬完成不代表模型完成。

UGen300 接入仍需依供應商 SDK 確認模型、HEF 與 runtime 相容性。PC 與 UGen300 的量化、速度、功耗及 USB 行為須分別驗證。
