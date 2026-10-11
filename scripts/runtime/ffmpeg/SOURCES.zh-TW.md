# FFmpeg runtime 來源紀錄

[English](SOURCES.md) | [繁體中文](SOURCES.zh-TW.md)

UFriend 將這個未修改的 FFmpeg 執行檔作為獨立的本機程序執行，用於繪製字幕與編碼影片。本文件僅說明 FFmpeg，不會變更 UFriend 或其其他依賴的授權。

- 散布者：Gyan Doshi，https://www.gyan.dev/ffmpeg/builds/
- 建置版本：`8.1.2-essentials_build-www.gyan.dev`，Windows x64，靜態連結。
- 授權：GNU GPL 第 3 版；完整上游授權位於本文件旁的 `COPYING.GPLv3.txt`。
- 原始套件：
  https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z
- 發行者 SHA-256 校驗檔：
  https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z.sha256
- 原始壓縮檔 SHA-256：
  `e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6`
- 發行者的發布鏡像：
  https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2
- 發行者 README 所指出的 FFmpeg 原始碼修訂版：
  https://github.com/FFmpeg/FFmpeg/commit/38b88335f9
- 該修訂版的 FFmpeg 原始碼封包：
  https://github.com/FFmpeg/FFmpeg/archive/38b88335f9.tar.gz
- FFmpeg 授權資訊：https://ffmpeg.org/legal.html

`UPSTREAM-README.txt` 是同一套件中完整、未修改的 README，保留發行者的元件清單與外部函式庫版本。`runtime.json` 記錄預期的執行檔雜湊、上游文件雜湊，以及執行檔回報的完整 configure 設定。此建置包含 libass 與 libx264，並啟用 `--enable-gpl` 及 `--enable-version3`；它不是僅採 LGPL 的建置，也未設定 `--enable-nonfree`。

上述原始碼連結與清單是來源資訊，**不是完整的對應來源散布**。目前這份 UFriend 建置是本機開發交付物。在向他人散布發布版本之前，應保留並透過 GPL 允許的散布方式，提供 FFmpeg 與所含外部函式庫的確切對應來源、必要的建置腳本與設定、聲明及適用授權。FFmpeg 原始碼封包本身不包含所有這些外部函式庫。重新散布執行檔時，不得移除這些聲明。本文件不會建立任何公開來源託管或原始碼提供承諾。

此二進位檔案依其 GPL 授權所述，不提供擔保。
