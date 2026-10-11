# Gmail 設定指南

[English](GMAIL_SETUP_GUIDE.md) | [繁體中文](GMAIL_SETUP_GUIDE.zh-TW.md)

UFriend 的公開原始碼與公開發行包不提供共用 Google OAuth 用戶端。要連接 Gmail，請先建立自己的 **Desktop app OAuth client**，在 UFriend 匯入設定，再授權自己的 Google 帳號。不使用 Gmail 時，仍可匯入 EML 並管理本機草稿。

Client ID 識別的是應用程式；每個 Gmail 帳號的授權 Token 則在登入後另外產生。UFriend 透過系統瀏覽器登入，不接收 Google 密碼。Google Console 名稱與帳號政策可能調整，請以連結的官方文件及實際畫面為準。

## 準備

- 可管理 Google Cloud 專案並使用 Gmail 的 Google 帳號。
- 已依[安裝指南](INSTALL_BUILD.zh-TW.md)開啟的 UFriend。
- 儲存 OAuth 下載檔的位置，使用儲存庫外的資料夾或已由 Git 排除的 `local/credentials/`。不要提交下載檔、Token 或 API Key，也不要將它們貼到公開 issue。

此流程使用 **OAuth Client ID**，不使用 API Key、Service Account 或 Web application client。[Google 憑證類型](https://developers.google.com/workspace/guides/create-credentials)

## 1. 建立專案與啟用 Gmail API

1. 開啟 [Google Cloud Console](https://console.cloud.google.com/)，建立或選擇由你管理的專案，例如 UFriend。
2. 確認上方專案選擇器顯示正確的專案。
3. 進入 **APIs & Services → Library**，搜尋 **Gmail API** 並啟用。
4. 在已啟用的 API 清單確認 Gmail API 存在。

後續 OAuth 設定須使用同一個專案。[建立專案](https://developers.google.com/workspace/guides/create-project) · [啟用 Workspace API](https://developers.google.com/workspace/guides/enable-apis)

## 2. 設定同意畫面與使用者

進入 **Google Auth Platform**，完成 **Branding** 的應用程式名稱、支援信箱與聯絡資訊。自用測試可選適合個人帳號的 External audience，保留 **Testing** 狀態，並在 **Audience → Test users** 加入實際要登入的帳號。組織帳號的可用設定取決於組織政策。

不要將測試信箱示意值當成真正的使用者；Google Cloud 專案聯絡信箱與 Test users 名單是不同設定。[OAuth 同意畫面](https://developers.google.com/workspace/guides/configure-oauth-consent)

## 3. 加入權限

在 **Data Access → Add or remove scopes** 加入並保存：

```text
https://www.googleapis.com/auth/gmail.modify
```

UFriend 使用這個範圍讀取與管理郵件、處理草稿及寄送。它屬於 Google 的 restricted scope，不提供略過垃圾桶的永久刪除。只授予 `gmail.readonly` 無法支援完整的郵件管理功能。[Gmail 權限表](https://developers.google.com/workspace/gmail/api/auth/scopes)

## 4. 建立 Desktop client 並下載 JSON

1. 開啟 **Clients → Create Client**。
2. Application type 選 **Desktop app**。
3. 輸入可辨識的名稱，例如 UFriend Windows。
4. 建立後下載並妥善保存原始 JSON。

不要選 Web application。UFriend 自行啟動暫時的 `127.0.0.1` 回呼，不需要填寫網頁用的 JavaScript origins。[建立 Desktop client](https://developers.google.com/workspace/guides/create-credentials#desktop-app) · [Desktop OAuth 流程](https://developers.google.com/identity/protocols/oauth2/native-app)

## 5. 在 UFriend 匯入與登入

1. 開啟 **設定 → 郵件帳戶 → 進階設定（開發者）**。
2. 按「匯入 Google 設定檔」，選取下載的 Desktop app JSON。程式會檢查格式，不必逐欄複製。
3. 匯入完成後按「使用 Google 帳號連接」。
4. 在系統瀏覽器選取已允許使用的帳號，核對應用程式與要求的 Gmail 權限，再決定是否授權。
5. 回到 UFriend，確認帳號及同步狀態。「同步偏好」可調整首次同步範圍與自動同步間隔。

若出現未驗證應用程式提示，核對是否為自己的專案及允許的測試帳號；組織政策也可能阻止授權。不要略過不明應用程式的警告。

匯入只保存本機連接設定，不會修改原始碼中的空白範本，也不會把設定提供給其他使用者。清除本機覆寫後，公開版本仍是未配置狀態。首次同步失敗但帳號已連接時，先按該帳號旁的「同步」重試並查看錯誤，不必反覆建立 OAuth client。

## 資料與權限範圍

- 登入採用 OAuth、PKCE、state 與本機回呼。Gmail Token 透過 Electron `safeStorage` 保存。
- 郵件、附件、草稿與設定保存於本機工作空間；一般內容不是加密資料庫。
- Gmail 同步與寄送會連接 Google。啟用郵件分析時，必要文字與欄位會傳送到當次選定的本地或雲端模型端點；Gmail Token 不會送給模型。詳見[模型來源與資料流](MODEL_SOURCES.zh-TW.md)。
- 關閉模型服務不影響 Gmail 授權。授權 Gmail 也不會自動安裝模型或配置雲端 AI。
- 寄送結果不確定時，先查看 Gmail 寄件備份再決定是否重試；程式不會自動重寄。

## 開發者：在自己的成品中預先配置

一般公開發行版使用者應採上面的本機匯入方式。若維護自己的發行版本，可在打包時指定外部 OAuth JSON，完整流程見[安裝指南](INSTALL_BUILD.zh-TW.md#選配google-登入設定)。

`app/config/google-oauth.json` 應維持空白範本。打包器的 `UFRIEND_GOOGLE_OAUTH_FILE` 只把必要的 Desktop client 欄位寫入新成品；它們會隨該成品分發，使用者的授權 Token 仍另外保存在本機。打包成功或 `gmailConfigured: true` 都不代表 Google 已驗證應用程式。

要將自己的 OAuth client 提供給其他人使用，先核對 Google 的 audience、測試使用者限制、品牌與 restricted-scope 驗證要求，以及真實部署的資料流。切換為 Production 不等於完成驗證。本指南不宣稱 UFriend 的公開發行包附有已驗證的共用 OAuth client。

官方參考：[Audience 與授權期限](https://support.google.com/cloud/answer/15549945?hl=en) · [Restricted-scope 驗證](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## 常見問題

| 情況 | 檢查方式 |
| --- | --- |
| 帳號無法存取或未列為測試使用者 | 核對登入帳號是否列於同一專案的 Test users，以及組織限制。 |
| 匯入 JSON 被拒絕 | 確認是 Google 下載的 Desktop app JSON，並非 Web client、服務帳戶或自行改寫的內容。 |
| 授權後沒有回到程式 | 保持 UFriend 開啟；取消後重新登入，保留不含憑證的錯誤資訊。 |
| 使用一段時間後要求重新登入 | 核對專案 Testing 狀態、授權期限或撤銷情況，依畫面重新連接。 |
| 帳號存在但沒有郵件 | 檢查同步狀態、首次同步天數與收件匣篩選。沒有符合範圍的郵件也可能是正常情況。 |
| 清除本機設定後不能登入 | 公開版本不附 OAuth client，請重新匯入自己的 Desktop JSON。 |
| 寄送結果不明 | 先查 Gmail 寄件備份，不要立即重寄。 |

更多操作見[使用手冊](APP_README.zh-TW.md)；Google API 用量規則以[官方配額文件](https://developers.google.com/workspace/gmail/api/reference/quota)為準。
