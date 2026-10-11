此檔為 UPSTREAM-README.txt 的繁體中文翻譯。英文原檔另行保留。

FFmpeg 8.1.2-ufriend1，Windows x64，為 UFriend 建置。
這是 UFriend 使用上游原始碼建立的版本，不是 Gyan 二進位檔。
FFmpeg 與選用的函式庫採靜態連結；只需要 Windows 系統 DLL。
包含支援 DirectWrite/GDI 的 libass、FreeType、FriBidi、HarfBuzz、x264 與 LAME。
保留 FFmpeg 原生編解碼器、容器及濾鏡；AAC 使用 FFmpeg 原生編碼器。
未啟用外部 TLS、網路通訊協定、fontconfig 或選用的硬體 SDK。
授權：此 FFmpeg 執行檔使用 GNU GPL 第 3 版或更新版本；請參閱 COPYING.GPLv3.txt。
UFriend 以獨立命令列程序呼叫此執行檔。
對應原始碼以 FFmpeg-8.1.2-ufriend1-corresponding-source.tar.xz 隨此影音元件一同提供。
來源封包包含每份固定版本的應用程式／函式庫輸入封包、建置流程，
以及產生的設定。未修改的通用工具與 Windows 系統函式庫
不包含在內；工具鏈版本與適用的 runtime 聲明均有記錄。
不提供擔保。請參閱隨附的授權條文。
