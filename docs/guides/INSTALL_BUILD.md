# UFriend 安裝、開發與打包指南

本指南適用於目前的 Windows x64 桌面版。一般使用者可執行完整的可攜式成品；開發者則依下列步驟從原始碼安裝依賴、準備影音工具、測試及打包。功能操作請參閱[使用說明](APP_README.md)。

## 使用已打包的程式

從 [GitHub Releases](https://github.com/breeze0305/UFriend/releases) 下載 Windows x64 release ZIP。GitHub 自動產生的 Source code ZIP／tar.gz 只有原始碼，不能直接執行。原始碼儲存庫不包含 `UFriend.exe`、`dist/` 或模型執行環境。

1. 將整個成品資料夾解壓縮到電腦上的一般資料夾。
2. 若舊版仍在執行，先從 Windows 系統匣選擇「結束 UFriend」。關閉視窗可能只會隱藏到系統匣。
3. 開啟成品資料夾中的 `UFriend.exe`。

請保留相鄰的 DLL、`resources/`、`locales/` 及授權檔，不能只複製 EXE。成品已附 Electron，使用者不需要安裝 Node.js、npm 或開發工具。Windows 剪貼簿通知元件使用 .NET Framework 4.x 執行環境。

公開 ZIP 不附 FFmpeg 執行檔；一般介面可先開啟。要使用含字幕影片匯出或雲端語音轉錄的音訊前處理，請在成品資料夾執行 **Install media runtime.cmd**，由安裝器從 Gyan 官方下載固定版本並核對雜湊。自動下載解壓需先有 7-Zip；也可將已解壓的固定套件交給 PowerShell 安裝器的 `-From` 選項。檔案會安裝到成品的 `resources/ffmpeg/`，確切命令見 [FFmpeg runtime 說明](../development/FFMPEG_RUNTIME.md)。本地 Whisper 的音訊前處理由其獨立服務準備，不使用這個桌面安裝器。

本機資料預設保存在 `%APPDATA%\UFriend\workspace`，可從設定 → 一般 →「開啟資料位置」查看。備份前請完全結束程式，再備份整個工作空間；更換 Windows 帳戶或電腦後，郵件帳號須重新授權。程式資料夾與使用者工作空間是不同位置。

需要 AI 功能時，還須另外取得並啟動相容的模型服務，見下方[接入模型服務](#接入模型服務)。

## 開發環境

以下是目前的開發需求；固定依賴版本以 `package-lock.json` 及 runtime manifest 為準。

| 項目 | 版本或要求 | 用途 |
| --- | --- | --- |
| 作業系統 | Windows x64 | 目前的原生元件與可攜式打包目標 |
| Node.js | 24.x | 執行 npm、建置腳本與測試 |
| npm | 隨 Node.js 24 安裝的相容版本 | 依 `package-lock.json` 安裝套件 |
| Git | 支援目前 Windows 的 Git | 取得與管理原始碼 |
| Windows PowerShell | 5.1，命令為 `powershell.exe` | 編譯剪貼簿元件、產生圖示與打包 |
| .NET Framework | 4.x，需具備 `csc.exe` | 編譯 C# 剪貼簿通知元件 |
| Electron | 44.3.0，由專案固定 | 桌面程式執行環境，不需全域安裝 |
| FFmpeg | Gyan `8.1.2-essentials_build-www.gyan.dev` | 字幕影片匯出、影音測試與打包 |
| 7z 解壓縮工具 | 能解開 `.7z` 套件即可 | 解壓固定的 FFmpeg 下載檔 |

PowerShell 7 可用於輸入一般命令，但建置腳本會呼叫 Windows PowerShell 5.1。原生建置會依序尋找：

```text
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
```

目前主程式沒有要求另裝 Visual Studio、Python 或 CUDA；三個模型服務的環境需求由各服務自己的文件決定。

## 從原始碼啟動

取得原始碼後，在含有 `package.json` 和 `package-lock.json` 的專案根目錄開啟 PowerShell。以下命令都在該目錄執行，不依賴資料夾名稱或特定使用者路徑。

### 1. 安裝依賴

```powershell
node --version
npm --version
npm ci
```

`npm ci` 依 lockfile 安裝正式與開發依賴；首次安裝需要網路下載 npm 套件與 Electron。請保留 `package-lock.json`，不要用省略開發依賴的方式安裝，因為 Electron 是開發依賴。

若安裝完成後仍缺少 `node_modules/electron/dist/electron.exe`，在同一目錄補執行 Electron 安裝腳本：

```powershell
node node_modules/electron/install.js
```

這個步驟使用已安裝套件指定的 Electron 版本。若 PowerShell 的執行原則阻擋 `npm.ps1`，可將本文的 `npm` 命令改用 `npm.cmd`。

### 2. 編譯 Windows 原生元件

```powershell
npm run build:native
```

成功後產生 `app/native/ClipboardListener.exe`。此檔由原始碼建置，不提交 Git；打包器會要求它已存在。若出現找不到 C# 編譯器的錯誤，請先確認上列 .NET Framework 4.x 的 `csc.exe` 路徑可用，再重跑此命令。

### 3. 準備固定的 FFmpeg 與測試工具

依 [FFmpeg runtime 說明](../development/FFMPEG_RUNTIME.md)下載指定的 **8.1.2 essentials** 套件，核對該文件提供的壓縮檔 SHA-256，再解壓縮。不可用任意新版替代，準備與打包腳本會核對固定版本、檔案雜湊及編碼能力。

將以下 `$ffmpegSource` 改成實際的解壓縮資料夾。該層必須含有 `bin/ffmpeg.exe`、`bin/ffprobe.exe`、`LICENSE` 與 `README.txt`：

```powershell
$ffmpegSource = Read-Host '已解壓 FFmpeg 套件的資料夾'
node scripts/prepare-ffmpeg.cjs --from $ffmpegSource
```

準備成功後，桌面程式使用的 FFmpeg 會放入 `local/runtimes/ffmpeg/win32-x64/`。此快取及下載的套件均不提交 Git；已有有效快取時可單獨執行 `node scripts/prepare-ffmpeg.cjs` 再次驗證。

完整影音測試還需要 `ffprobe.exe` 與 FFmpeg 位於同一目錄。請保留解壓縮的固定套件，並在目前 PowerShell 視窗將測試路徑指向該套件的 `bin/ffmpeg.exe`：

```powershell
$env:UFRIEND_TEST_FFMPEG = (Resolve-Path -LiteralPath (Join-Path $ffmpegSource 'bin/ffmpeg.exe')).Path
```

`UFRIEND_TEST_FFMPEG` 供測試產生與檢查合成影音，使用解壓縮套件內相鄰的 `ffmpeg.exe` 與 `ffprobe.exe`；桌面程式實際匯出字幕影片時則使用固定快取，可攜式成品使用其 `resources/ffmpeg/` 中已安裝的 FFmpeg。打包器不會將 ffprobe 加入成品。重新開啟 PowerShell 後，測試前須再次設定此環境變數。

### 4. 啟動程式

```powershell
npm start
```

開發版與成品版預設使用同一個使用者資料位置。若要隔離開發資料，可指定已由 Git 排除的 `.test-data/dev`：

```powershell
try {
  $env:UFRIEND_DATA_DIR = Join-Path $PWD.Path '.test-data/dev'
  New-Item -ItemType Directory -Path $env:UFRIEND_DATA_DIR -Force | Out-Null
  npm start
} finally {
  Remove-Item Env:UFRIEND_DATA_DIR -ErrorAction SilentlyContinue
}
```

啟動前請先正常結束其他 UFriend 執行個體。模型服務未啟動時仍可開啟桌面程式；需要模型的工作會提示未配置或未就緒。

## 驗證與測試

完成原生元件及 FFmpeg 準備，並設定好 `UFRIEND_TEST_FFMPEG` 後執行。首次執行介面測試前，先建立其隔離資料目錄：

```powershell
npm run check
npm test
New-Item -ItemType Directory -Path '.test-data/smoke' -Force | Out-Null
npm run smoke
```

| 命令 | 驗證內容與前置條件 |
| --- | --- |
| `npm run check` | 檢查 `app/`、`scripts/` 與 `tests/` 的 JavaScript 語法 |
| `npm test` | 執行 Node 測試，含本機保存、郵件模擬、取消流程與合成影片字幕壓制；實際影片測試需要 FFmpeg 及同目錄的 ffprobe |
| `npm run smoke` | 在隱藏 Electron 視窗執行介面與影音流程；使用隔離資料及模型替身，不需要真實 Gmail 帳號或模型服務 |

請查看測試結果中的失敗與略過項目。缺少 FFmpeg／ffprobe 時，部分影音單元測試會被略過；`smoke` 的影音驗證則需要可用的 FFmpeg，不能僅以其他測試通過推定字幕匯出已驗證。

介面測試資料位於 `.test-data/smoke/`，報告與截圖輸出到 `.test-results/`；兩者均不提交 Git。一般 `smoke` 不讀取系統剪貼簿、不操作真實帳號。

真模型驗證屬於另外的整合測試：

首次執行前同樣先建立各測試的隔離資料目錄：

```powershell
New-Item -ItemType Directory -Path '.test-data/llm-features-smoke', '.test-data/clipboard-smoke', '.test-data/model-smoke' -Force | Out-Null
```

| 命令 | 額外需求 |
| --- | --- |
| `npm run smoke:llm` | LLM 服務已就緒且閒置；使用合成文字 |
| `npm run smoke:clipboard` | OCR 服務已就緒且閒置；會以合成圖片操作真正的 Windows 剪貼簿，並有條件恢復原內容 |
| `npm run smoke:models` | 三個服務已就緒且閒置，另需自行準備腳本指定的本機測試音檔；原始碼儲存庫不提供該音檔 |

整合測試的準備與輸出位置見 [PC 模型指南](PC_MODELS.md)及 [LLM 功能與除錯指南](LLM_FEATURES.md)。它們不會替你安裝、下載或啟動模型服務。

## 建立可攜式成品

請先完成依賴安裝、原生編譯及適當測試。公開 ZIP 採用不附 FFmpeg 執行檔的模式，在 Windows x64 執行：

```powershell
npm run package -- --without-ffmpeg
```

這個模式附有選用的媒體 runtime 安裝器，使用者需另外安裝後才能匯出含字幕影片或使用雲端語音轉錄。它不需要事先有開發用 FFmpeg 快取；完整影音測試仍需要前述測試工具。

若只在本機建立含有已準備 FFmpeg 的成品，先完成固定 runtime 的驗證，再執行 `npm run package`。兩種打包模式均使用已安裝的 Electron、lockfile 對應的正式依賴及原生元件，不會代跑 `npm ci`、`build:native` 或完整測試。

輸出位於 `dist/UFriend-<package.json 版號>/`；若同版號資料夾已存在，會建立帶有建置時間的新資料夾，實際路徑以命令輸出為準。成功後會有 `UFriend.exe` 與 `BUILD-INFO.json`，其中記錄版號、Electron、平台、正式依賴和影音 runtime 資訊。請開啟新成品確認可正常啟動，分享時保留整個資料夾。

打包器會先驗證依賴、圖示及該模式需要的 runtime 檔案，成功後才整理舊的 UFriend 成品，保留最新驗證成功的版本。若舊版仍在執行或檔案被鎖定，會保留該版本；從系統匣正常結束後可執行：

```powershell
npm run clean:dist
```

整理僅處理 `dist/` 中可辨識的 UFriend 成品，不清除使用者工作空間或獨立模型服務。打包失敗時請保留既有可用成品，不要先清空 `dist/`。對外分發附帶的 FFmpeg 前，另依 [FFmpeg 的授權與來源紀錄](../development/FFMPEG_RUNTIME.md#授權與來源紀錄)準備所需的對應來源與聲明。

### 選配：Google 登入設定

Google 登入設定不影響一般桌面建置。原始碼中的 `app/config/google-oauth.json` 必須維持空白範本，**不要將真實 Client ID、Client Secret 或 Token 填入已追蹤的檔案**。

開發時可在「設定 → 郵件帳戶 → 進階設定」匯入 Google Desktop OAuth JSON。建立與匯入流程見 [Gmail 設定指南](GMAIL_SETUP_GUIDE.md)。下載檔請保存在已排除於 Git 的 `local/credentials/google-oauth-client.json`，或其他儲存庫外的位置。

公開 release 使用空白 OAuth 範本，由使用者在本機匯入自己的設定。若要建立預先包含自己 Desktop client 的私人部署成品，打包時可指定外部檔案：

```powershell
try {
  $env:UFRIEND_GOOGLE_OAUTH_FILE = (Resolve-Path -LiteralPath 'local/credentials/google-oauth-client.json').Path
  npm run package -- --without-ffmpeg
} finally {
  Remove-Item Env:UFRIEND_GOOGLE_OAUTH_FILE -ErrorAction SilentlyContinue
}
```

打包器會先驗證設定，只將必要的 Desktop client 欄位寫入新成品，不修改原始碼範本。這些欄位會隨成品分發；使用者的授權 Token 則另外保存在其本機加密憑證庫。未提供外部設定時仍可打包，成品會提示 Google 登入尚未配置。

## 接入模型服務

主儲存庫只提供桌面程式及 HTTP adapter。`PC-LLM-API`、`PC-OCR-API`、`PC-Whisper-API` 是各自維護的獨立專案，不會隨 `git clone`、`npm ci` 或桌面成品取得；Python、CUDA、模型權重與服務執行環境也不包含在主儲存庫。

請另外向維護者取得需要的相容服務，依各服務的 README 安裝並啟動。主程式不會替服務執行安裝或管理其生命週期。

| 服務 | 桌面預設端點 |
| --- | --- |
| LLM | `http://127.0.0.1:8765` |
| OCR | `http://127.0.0.1:8767` |
| Whisper | `http://127.0.0.1:8768` |

服務就緒後，在 UFriend 設定 → 模型與運算 → 本地，選擇 PC API，保存端點並測試連線；各次任務再選「本地」。雲端支援另行設定的 OpenAI 相容 API，會議轉錄也使用上述 FFmpeg 準備上傳音訊；UGen300 實體裝置仍未接入。來源設定見[模型來源指南](MODEL_SOURCES.md)，本地 API v1 與健康檢查見[模型介面契約](../../app/models/README.md)。
