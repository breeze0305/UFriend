# UFriend Windows clipboard notification helper

[English](README.md) | [繁體中文](README.zh-TW.md)

`ClipboardListener.exe` is a C# 5 / .NET Framework 4.x console helper. It runs a WinForms STA message loop with a message-only window and registers `AddClipboardFormatListener`. Electron should launch it only while automatic image recognition is enabled.

## Build

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File app/native/build.ps1` from the project directory, or run the script by its absolute path from any directory. The script locates the existing Windows Framework 4.x `csc.exe` and writes `ClipboardListener.exe` beside the source. It downloads nothing.

## Electron interface

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
  // ready: registration succeeded.
  // clipboard: a new image format is available; main decides whether to read it.
  // error: mark monitoring unavailable and inspect the process exit code.
});
// Preferred shutdown, including on app exit:
child.stdin.end('stop\n');
// If it has not exited after a short timeout, child.kill() is a fallback.
```

Stdout contains UTF-8 newline-delimited JSON only, flushed after every event:

```json
{"type":"ready"}
{"type":"clipboard","sequence":123}
{"type":"error","message":"Could not register clipboard notifications."}
```

- `ready` is emitted only after listener registration succeeds. Startup failure emits `error` and exits with code `1`; runtime or cleanup failure exits with code `2`; normal shutdown exits with code `0`.
- Only notifications after startup are considered. Startup records a sequence baseline without querying current formats or reading current clipboard content.
- On a new sequence, the helper checks only availability of `CF_DIB`, `CF_DIBV5`, or `CF_BITMAP`. It never opens, reads, copies, writes, or stores clipboard contents. Text-only events are ignored. Repeated notifications for the same sequence are suppressed; very rapid changes can coalesce.
- The sequence is a Windows 32-bit unsigned counter, not a timestamp. Clipboard contents can change again before Electron reads them. Electron must re-check the current content and avoid treating stale OCR results as belonging to a newer image.
- `stop` on stdin, stdin EOF, or Ctrl+C exits the message loop and calls `RemoveClipboardFormatListener` before destroying the window. A force kill cannot run managed cleanup; Windows destroys the process window and reclaims its registration. Prefer the stdin shutdown when practical.
- The helper does not perform OCR or Windows screenshot capture. It cannot prove that a clipboard image came specifically from Snipping Tool.

Implementation references: [AddClipboardFormatListener](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener), [WM_CLIPBOARDUPDATE](https://learn.microsoft.com/en-us/windows/win32/dataxchg/wm-clipboardupdate), [GetClipboardSequenceNumber](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber), [IsClipboardFormatAvailable](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-isclipboardformatavailable).
