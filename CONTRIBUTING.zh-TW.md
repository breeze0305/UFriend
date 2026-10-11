# 參與 UFriend 貢獻

[English](CONTRIBUTING.md) | [繁體中文](CONTRIBUTING.zh-TW.md)

可重現的錯誤與功能需求請使用 [GitHub Issues](https://github.com/breeze0305/UFriend/issues)提出。安全漏洞請依[安全問題回報方式](SECURITY.zh-TW.md)處理。

## 回報問題

請提供 UFriend 版本、Windows 版本、使用本地或雲端處理來源、重現步驟、預期行為與實際結果。優先提供少量合成的 EML、圖片或錄音，避免使用個人資料。分享前檢查截圖與紀錄，移除帳號資訊、API 金鑰、OAuth 檔案、郵件內容及私人路徑。

## 提出修改

較大的變更請先在 issue 討論。讓修改範圍集中、說明修改後的行為，並更新相關文件。對專案自有程式碼的貢獻以 [MIT 授權](LICENSE)提供；加入第三方素材時，保留其授權及來源註記。

每份專案說明都須分別提供英文（`NAME.md`）與繁體中文（`NAME.zh-TW.md`）檔案。兩版應同時更新，保持指令、事實與限制一致，加入語言切換連結，並在 `docs/README.md` 與 `docs/README.zh-TW.md` 都列出新增文件。上游授權原文與固定雜湊的影音元件中繼資料須逐位元保留；請另外提供翻譯並從文件目錄連結，不直接修改受校驗的原檔。

1. 依 [Windows 安裝指南](docs/guides/INSTALL_BUILD.zh-TW.md)準備環境，使用 `npm ci` 保持固定的依賴版本。
2. 透過 `UFRIEND_DATA_DIR` 使用隔離工作空間，不要直接在唯一一份個人工作資料上開發。
3. 執行 `npm run check` 及適合本次修改的測試。提交貢獻前執行 `npm test`，並回報跳過的影音檢查。UI 或原生元件修改可能也需要指南列出的 smoke 測試。
4. 在 pull request 說明問題、行為變更、驗證方式及剩餘限制。涉及介面時，一併更新英文與繁體中文。

不要加入憑證、OAuth 下載檔、個人郵件、錄音、模型權重、依賴資料夾、發布套件或測試輸出。`app/config/google-oauth.json` 必須維持空白範本。PC 模型服務是獨立專案，相關變更應提交到各自的 repository。

建置與打包細節，包括 FFmpeg 前置需求，見[安裝指南](docs/guides/INSTALL_BUILD.zh-TW.md)。`npm run package:portable` 使用固定版本的 electron-builder 工具鏈建置單一 EXE，不會發布版本。修改單檔啟動器或影音元件安裝器時，應檢查重新啟動、資料持續保存，以及失敗時保留既有檔案的行為。成功打包不能取代工作流程測試。
