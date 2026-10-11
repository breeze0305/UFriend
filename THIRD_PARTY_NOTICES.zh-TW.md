# 第三方軟體

[English](THIRD_PARTY_NOTICES.md) | [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md)

[MIT 授權](LICENSE)適用於 UFriend 自有程式碼。第三方元件保留各自的著作權與授權。

- **Electron 與 Chromium**：資料夾套件會在應用程式執行檔旁保留 Electron 的 `LICENSE` 與 `LICENSES.chromium.html`。單一 EXE 內含該程式套件，並在執行時將它及聲明檔展開至暫存目錄。
- **npm 依賴**：確切版本與宣告的授權記錄在 `package-lock.json`。正式依賴的授權檔保存在程式套件的 `resources/app/node_modules` 內。
- **建置工具**：單一 EXE 使用固定版本 electron-builder 26.17.0 的 NSIS portable 目標產生。建置依賴記錄在 lockfile，保留各自授權，與 UFriend 專案授權分開處理。
- **內建 FFmpeg**：UFriend Windows 發布版將 UFriend 自行建置的 FFmpeg 作為獨立執行檔內建。此建置啟用包括 x264 在內的 GPL 元件，以 GPLv3 提供。執行檔隨附 GPL 全文、`THIRD_PARTY_LICENSES.txt`，以及 `scripts/runtime/ffmpeg-bundled` 的來源與建置資訊。相符的完整來源壓縮檔包含連結使用的依賴原始碼與建置腳本，與 EXE 一起提供於同一個 GitHub Release；確切雜湊記錄在內建影音元件的 manifest。這些條款不會改變 UFriend 獨立 MIT 程式碼的授權。
- **選裝 FFmpeg**：未內建 FFmpeg 的建置保留選裝安裝器，直接向發行者下載固定版本的 Gyan GPLv3 建置，或接受使用者已解壓縮的官方套件。其獨立聲明與 manifest 保存在 `scripts/runtime/ffmpeg`，此途徑不重新散布 Gyan 執行檔。透過設定安裝的元件會保存在 Windows 使用者資料目錄，更新程式後仍保留。詳見 [FFmpeg 影音元件文件](docs/development/FFMPEG_RUNTIME.zh-TW.md)。

重新散布第三方二進位檔案時，須遵守它們各自的條款。UFriend 授權不會取代或改變這些元件的授權。
