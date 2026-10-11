# FFmpeg 媒體 runtime

UFriend 使用獨立的 FFmpeg 程序處理含字幕影片匯出，以及雲端語音轉錄前的音訊擷取與分段。只有使用者明確操作安裝功能時才下載工具；影音工作不搜尋系統 `PATH`，也不啟停獨立 PC 模型服務。

目前固定使用 Gyan 的 **8.1.2-essentials_build-www.gyan.dev** Windows x64 build。版本、上游下載位址與檔案 SHA-256 位於 [runtime.json](../../scripts/runtime/ffmpeg/runtime.json)。

## 從 UFriend 設定安裝

目前公開單一 EXE 與不含影音元件的 ZIP 都**不內附 FFmpeg 執行檔**。若使用自行建置的 `Portable-WithFFmpeg.exe` 本機版，影音元件已內建，略過安裝步驟即可使用。先開啟 UFriend，再進入 **設定 → 一般 → 影音元件**（**Settings → General → Media runtime**）：

| 按鈕 | 行為 |
| --- | --- |
| 下載並安裝影音元件 / Download and install media runtime | 從 Gyan 官方下載固定套件，核對 SHA-256 後解壓與安裝；需要電腦已有 7-Zip。 |
| 選擇已解壓的套件 / Select extracted package | 開啟原生資料夾選擇器，讀取自行準備的官方套件；不下載，也不需要 7-Zip。 |
| 影音元件安裝說明 / Media runtime instructions | 在瀏覽器開啟本指南。 |

自動下載會尋找 `7z.exe` 或 `7za.exe`，包含一般 7-Zip 安裝位置。缺少工具時會顯示錯誤，不自動安裝 7-Zip；可先安裝解壓工具，或改選已解壓的套件。來源套件須包含 `bin/ffmpeg.exe`、`LICENSE` 與 `README.txt`。

安裝期間顯示進行狀態，完成後顯示「影音元件已就緒」。失敗可依畫面原因修正後重試。從系統匣結束或重新啟動 UFriend，會停止它啟動的安裝程序；只關閉視窗並留在系統匣時，程式仍在執行。

安裝不要求系統管理員權限，所選使用者資料目錄須可寫入。原始碼開發版使用下方的開發快取準備流程，設定頁安裝器供已打包版本使用。

## 保存位置與程式更新

設定頁安裝的 runtime 位於 Electron 使用者資料目錄的 `media-runtime/ffmpeg/`，預設為：

```text
%APPDATA%\UFriend\media-runtime\ffmpeg\
  ffmpeg.exe
  COPYING.GPLv3.txt
  UPSTREAM-README.txt
  SOURCES.md
  runtime.json
```

它與工作資料 `%APPDATA%\UFriend\workspace` 分開，不放在單一 EXE 每次啟動產生的暫存解壓目錄。使用相同 Windows 帳戶及資料目錄時，重新啟動或換成新的 portable EXE 後仍可使用。若設定 `UFRIEND_DATA_DIR`，影音元件會保存在該目錄下的 `media-runtime/ffmpeg/`。

含元件版本優先使用程式內 `resources/ffmpeg/` 的已驗證 runtime；未內建的版本使用這個持久 runtime。關閉程式不刪除已成功安裝的影音元件，工作空間資料清理也不包含它。

安裝器在發布安裝目錄前核對完整的固定檔案。有有效安裝時可驗證後結束；已有目錄內容不符時會報錯，不自行覆寫。下載、驗證或解壓失敗不會把未完成的安裝當成成功。完成後可重試原本的影音工作。

LLM、OCR 與本地 Whisper 仍依[模型指南](../guides/PC_MODELS.md)各自配置。本地 Whisper 有自己的音訊處理 runtime；安裝桌面 FFmpeg 不會安裝語音模型。

## 自行下載及解壓

使用[固定上游套件](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z)。壓縮檔 SHA-256 應為：

```text
e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6
```

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256 -LiteralPath <檔案路徑>` 核對，亦可參照[發行者校驗檔](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z.sha256)。

使用自己的相容工具解壓後，回到設定頁按「選擇已解壓的套件」，選取含 `bin/ffmpeg.exe`、`LICENSE`、`README.txt` 的資料夾。安裝器仍會核對固定執行檔與上游文件的 SHA-256。不要使用不同版本或任意重新編譯的執行檔替代。

## ZIP 資料夾包的命令列方式

完整 ZIP 解壓後仍可使用根目錄的 **Install media runtime.cmd**。在該資料夾的 PowerShell 執行以下命令，自動下載固定套件：

```powershell
& '.\Install media runtime.cmd'
```

自動下載同樣需要已安裝的 7-Zip；或者使用已解壓的官方套件：

```powershell
$ffmpegSource = Read-Host '已解壓 FFmpeg 套件的資料夾'
& '.\Install media runtime.cmd' -From $ffmpegSource
```

也可直接執行資料夾包內的 PowerShell 安裝器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\resources\media-runtime-setup\install-media-runtime.ps1' -From $ffmpegSource
```

`-From` 不下載、不需要 7-Zip。這組命令預設安裝到**該資料夾包**的 `resources/ffmpeg/`，因此只保存在該份成品內；要跨程式更新保留，優先使用設定頁安裝。

進階呼叫可用 `-DestinationRoot` 指定絕對目錄，安裝器會在其下建立 `ffmpeg/`。設定頁已自動提供正確的使用者資料路徑，正常操作不需要這個參數。任意指定其他目錄不會改變 UFriend 的 runtime 搜尋位置。

不要手動在單一 EXE 的暫存解壓目錄安裝工具；使用設定頁即可保存至持久位置。

## 原始碼開發環境

開發流程與設定頁安裝器分開。在專案根目錄，將來源指向已下載、核對及解壓的固定套件：

```powershell
$ffmpegSource = Read-Host '已解壓 FFmpeg 套件的資料夾'
node scripts/prepare-ffmpeg.cjs --from $ffmpegSource
```

準備程序核對固定 SHA-256、版本、編譯設定、ASS／subtitles 濾鏡與 libx264／AAC 編碼器，通過後才放入 `local/runtimes/ffmpeg/win32-x64/`。已有有效快取時可執行 `node scripts/prepare-ffmpeg.cjs` 再次驗證。失敗保留現有檔案，不自動改用另一個版本。

完整影音測試還需要同一上游套件的 `ffprobe.exe`。在執行測試的 PowerShell 中設定：

```powershell
$env:UFRIEND_TEST_FFMPEG = (Resolve-Path -LiteralPath (Join-Path $ffmpegSource 'bin/ffmpeg.exe')).Path
```

保留同目錄的 `ffprobe.exe`，再按[安裝指南](../guides/INSTALL_BUILD.md#驗證與測試)執行檢查。該變數只用於測試；桌面開發版使用固定快取。下載、快取與測試輸出不加入 Git。

## 打包模式

| 命令 | 產物及 FFmpeg 處理 |
| --- | --- |
| `npm run package:portable` | 單一 Windows portable EXE。使用無內附 FFmpeg、無 OAuth 設定的資料夾包作為輸入，透過 electron-builder NSIS portable target 包裝；供使用者從設定頁安裝 runtime。 |
| `npm run package:portable -- --with-ffmpeg` | 本機測試用單一 EXE，檔名為 `Portable-WithFFmpeg.exe`。內含固定 FFmpeg 與授權／來源文件，並在包裝前核對雜湊、版本、字幕濾鏡及編碼器；首次使用不需安裝影音元件。 |
| `npm run package -- --without-ffmpeg` | 可供 ZIP 分發的資料夾包。附設定頁安裝器、CMD 入口、版本資訊及上游聲明，不附 FFmpeg 執行檔；無需開發用 FFmpeg 快取即可打包。 |
| `npm run package` | 從已驗證的開發快取複製 runtime 的資料夾包，適合本機使用。打包前及複製後均進行校驗與功能探測。 |

以上均不包含獨立 PC 模型服務。資料夾包的 `BUILD-INFO.json` 記錄打包時是否內附 runtime；使用者日後安裝不會改寫成「原本內附」。單一 EXE 另有 `PORTABLE-BUILD-INFO.json` 建置紀錄。產物位置與完整流程見[安裝指南](../guides/INSTALL_BUILD.md#建立可攜式成品)。

## 授權與來源紀錄

UFriend 專案採 [MIT License](../../LICENSE)。固定 Gyan FFmpeg build 啟用了 GPL、version3、libass 與 libx264，依其 **GPLv3** 授權提供；UFriend 的 MIT 授權不替代這些條款。

[來源紀錄](../../scripts/runtime/ffmpeg/SOURCES.md)、完整上游 README 與 GPL 原文保留於 `scripts/runtime/ffmpeg/`。公開版本內的選用安裝器保留這些文件，安裝後與執行檔一起放入目的 runtime 目錄。`.gitattributes` 保留相關上游文字的原始位元組，以便核對雜湊。

預設公開 EXE 與無 FFmpeg 的 ZIP 不重新分發該 FFmpeg 執行檔，使用者的安裝器直接向上游取得。若自行分發含 FFmpeg 的包，應依該元件的授權準備精確對應原始碼、外部函式庫、建置腳本及適用聲明；現有來源網址清單不等於完整 corresponding-source 包。

參考：[Gyan build 說明](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg 授權資訊](https://ffmpeg.org/legal.html) · [第三方聲明](../../THIRD_PARTY_NOTICES.md)
