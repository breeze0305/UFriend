# FFmpeg 媒體 runtime

UFriend 使用獨立的 FFmpeg 程序處理含字幕影片匯出，以及雲端語音轉錄前的音訊擷取與分段。執行工作時不自動下載工具、不搜尋系統 `PATH`，也不啟停獨立 PC 模型服務。

目前固定使用 Gyan 的 **8.1.2-essentials_build-www.gyan.dev** Windows x64 build。版本、上游下載位址與檔案 SHA-256 位於 [runtime.json](../../scripts/runtime/ffmpeg/runtime.json)。

## 公開可攜式 ZIP：選擇安裝

公開 ZIP 使用 `--without-ffmpeg` 打包，**不包含 FFmpeg 執行檔**。完整解壓後可直接開啟 `UFriend.exe`；要匯出含字幕影片或使用雲端語音轉錄，才需完成下列安裝。LLM、OCR 與本地 Whisper 仍依[模型指南](../guides/PC_MODELS.md)各自配置；本地 Whisper 有自己的音訊處理 runtime。

### 自動下載

先在電腦準備可用的 7-Zip，再雙擊解壓後應用程式資料夾內的 **Install media runtime.cmd**。也可在該資料夾的 PowerShell 執行：

```powershell
& '.\Install media runtime.cmd'
```

安裝器尋找 `7z.exe` 或 `7za.exe`，包含一般的 7-Zip 安裝位置。它從 Gyan 官方下載固定的 `.7z`，核對壓縮檔 SHA-256，再解壓並核對執行檔及授權文件。缺少 7-Zip 時會顯示手動操作說明，不會安裝系統工具。

安裝不要求系統管理員權限，但應用程式資料夾需要可寫入。若資料夾位於受保護位置，請將完整 ZIP 解壓到自己的可寫入資料夾再安裝。

### 使用已解壓的套件

如果自行下載與解壓，使用[固定上游套件](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z)。壓縮檔 SHA-256 應為：

```text
e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6
```

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256 -LiteralPath <檔案路徑>` 核對，亦可參照[發行者校驗檔](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z.sha256)。

解壓後的來源資料夾應包含 `bin/ffmpeg.exe`、`LICENSE`、`README.txt`。在 UFriend 成品資料夾執行：

```powershell
$ffmpegSource = Read-Host '已解壓 FFmpeg 套件的資料夾'
& '.\Install media runtime.cmd' -From $ffmpegSource
```

若不需要 CMD 的完成暫停畫面，可以直接執行成品內的 PowerShell 安裝器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\resources\media-runtime-setup\install-media-runtime.ps1' -From $ffmpegSource
```

`-From` 不下載、不需要 7-Zip；安裝器仍核對固定執行檔與上游授權文件的 SHA-256。不要使用不同版本或任意重新編譯的執行檔替代。

### 安裝結果與更新

驗證完成後，安裝器一次發布以下資料夾：

```text
resources/ffmpeg/
  ffmpeg.exe
  COPYING.GPLv3.txt
  UPSTREAM-README.txt
  SOURCES.md
  runtime.json
```

有有效安裝時會驗證後結束；現有內容不符時會報錯，不自行覆寫。下載、驗證或解壓失敗不會將不完整內容標成成功安裝。程式使用 `resources/ffmpeg/ffmpeg.exe`；安裝成功後重試原工作即可。

可選安裝只影響這份 UFriend 成品。更新為另一個已解壓的公開 ZIP 時，請在新資料夾重新執行安裝器。一般工作資料仍保留在使用者工作空間，不在這個 runtime 資料夾中。

## 原始碼開發環境

開發流程與可攜式安裝器分開。在專案根目錄，將來源指向已下載、核對及解壓的固定套件：

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

| 命令 | FFmpeg 處理 |
| --- | --- |
| `npm run package -- --without-ffmpeg` | 公開 ZIP 使用的模式。只附選用安裝器、版本資訊及上游聲明，不附 FFmpeg 執行檔；無需開發用 FFmpeg 快取即可打包。 |
| `npm run package` | 從已驗證的開發快取複製 runtime，適合本機使用的完整成品。打包前及複製後均進行校驗與功能探測。 |

兩種模式皆不包含獨立 PC 模型服務。套件的 `BUILD-INFO.json` 記錄是否內附影音 runtime；打包成功不代表已通過完整影音工作流程測試。發布新包前仍應依實際模式驗證啟動、缺少 runtime 的提示及完成安裝後的操作。

## 授權與來源紀錄

UFriend 專案採 [MIT License](../../LICENSE)。固定 Gyan FFmpeg build 啟用了 GPL、version3、libass 與 libx264，依其 **GPLv3** 授權提供；UFriend 的 MIT 授權不替代這些條款。

[來源紀錄](../../scripts/runtime/ffmpeg/SOURCES.md)、完整上游 README 與 GPL 原文保留於 `scripts/runtime/ffmpeg/`。公開 ZIP 的選用安裝器也保留這些文件，下載後與執行檔一起放入 `resources/ffmpeg/`。`.gitattributes` 保留相關上游文字的原始位元組，以便核對雜湊。

目前公開 ZIP 不重新分發該 FFmpeg 執行檔，使用者的安裝器直接向上游取得。若自行分發含 FFmpeg 的包，應依該元件的授權準備精確對應原始碼、外部函式庫、建置腳本及適用聲明；現有來源網址清單不等於完整 corresponding-source 包。

參考：[Gyan build 說明](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg 授權資訊](https://ffmpeg.org/legal.html) · [第三方聲明](../../THIRD_PARTY_NOTICES.md)
