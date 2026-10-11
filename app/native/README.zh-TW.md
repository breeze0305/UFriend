# UFriend Windows 剪貼簿通知元件

[English](README.md) | [繁體中文](README.zh-TW.md)

`ClipboardListener.exe` 是以 C# 5／.NET Framework 4.x 實作的主控台元件。它透過僅接收訊息的視窗執行 WinForms STA 訊息迴圈，並註冊 `AddClipboardFormatListener`。Electron 應只在啟用自動圖片辨識時啟動它。

## 建置

在專案目錄執行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File app/native/build.ps1`，或在任意目錄使用腳本的絕對路徑執行。腳本會尋找既有的 Windows Framework 4.x `csc.exe`，並將 `ClipboardListener.exe` 寫入原始碼旁邊。它不會下載任何內容。

## Electron 介面

```js
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const child = spawn(helperAbsolutePath, [], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const event = JSON.parse(line);
  // ready：註冊成功。
  // clipboard：出現新的圖片格式；由主程序決定是否讀取。
  // error：將監聽標為不可用，並檢查程序的結束代碼。
});
// 優先使用此方式停止元件，包括應用程式結束時：
child.stdin.end('stop\n');
// 若短暫等待後仍未結束，可用 child.kill() 作為備用方式。
```

標準輸出只包含以換行分隔的 UTF-8 JSON，每次事件後都會立即清空輸出緩衝區：

```json
{"type":"ready"}
{"type":"clipboard","sequence":123}
{"type":"error","message":"Could not register clipboard notifications."}
```

- 只有監聽器註冊成功後才會發出 `ready`。啟動失敗會發出 `error` 並以代碼 `1` 結束；執行期間或清理失敗以代碼 `2` 結束；正常停止以代碼 `0` 結束。
- 只處理啟動後的通知。啟動時只記錄序號基準，不查詢目前的格式，也不讀取目前的剪貼簿內容。
- 收到新序號時，元件只檢查是否提供 `CF_DIB`、`CF_DIBV5` 或 `CF_BITMAP`。它從不開啟、讀取、複製、寫入或儲存剪貼簿內容。純文字事件會被忽略；相同序號的重複通知會被抑制，非常快速的變動可能合併為一次通知。
- 序號是 Windows 的 32 位元無號計數器，不是時間戳記。在 Electron 讀取之前，剪貼簿內容可能再次變動。Electron 必須重新檢查目前內容，避免將過期的 OCR 結果視為較新圖片的結果。
- 標準輸入收到 `stop`、標準輸入結束（EOF）或按下 Ctrl+C 時，會退出訊息迴圈，並在銷毀視窗前呼叫 `RemoveClipboardFormatListener`。強制終止程序無法執行受控清理；Windows 會銷毀該程序的視窗並回收其註冊。在可行時，應優先透過標準輸入停止。
- 此元件不執行 OCR，也不擷取 Windows 螢幕畫面。它無法證明剪貼簿圖片一定來自剪取工具。

實作參考：[AddClipboardFormatListener](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener)、[WM_CLIPBOARDUPDATE](https://learn.microsoft.com/en-us/windows/win32/dataxchg/wm-clipboardupdate)、[GetClipboardSequenceNumber](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber)、[IsClipboardFormatAvailable](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-isclipboardformatavailable)。
