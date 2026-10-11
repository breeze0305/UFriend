# UFriend 的 Windows FFmpeg 建置

[English](https://github.com/breeze0305/UFriend/blob/main/docs/development/MEDIA_RUNTIME_BUILD.md) | [繁體中文](https://github.com/breeze0305/UFriend/blob/main/docs/development/MEDIA_RUNTIME_BUILD.zh-TW.md)

這套建置流程使用七份固定版本與雜湊的原始碼封包，編譯帶有 `ufriend1` 後綴的 FFmpeg 8.1.2。它包含 x264、LAME、libass、FreeType、FriBidi 與 HarfBuzz。只要前置需求可用，就會保留 FFmpeg 原生的編解碼器、格式與濾鏡。libass 透過 DirectWrite/GDI 尋找已安裝的 Windows 字型。網路存取、fontconfig、額外編解碼函式庫與硬體 SDK 均停用。

GitHub Actions 工作流程在 Ubuntu 24.04 上建置，拒絕匯入 Windows 系統 DLL 以外的 PE 依賴，再於 Windows 執行兩個執行檔。Windows 工作會編碼及解碼 H.264/AAC、使用 DirectWrite 燒錄 UTF-8 字幕、透過 ffprobe 檢查中繼資料，並以 App 使用的相同格式準備一個 MP3 分段及 CSV。只有 Windows 工作通過後，編譯產物才算是已驗證的發布版本。

在 Ubuntu 24.04 安裝通用建置工具：

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential curl ca-certificates \
  xz-utils python3 meson ninja-build pkg-config nasm autoconf automake libtool \
  gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
  binutils-mingw-w64-x86-64 mingw-w64-tools
bash recipe/build.sh "$PWD/new-work" "$PWD/new-output" "$PWD/sources"
```

若使用 repository 的 checkout，請將 `recipe/build.sh` 改為 `scripts/runtime/build/build.sh`，並省略最後一個參數，讓流程下載固定的輸入封包。工作目錄與輸出目錄都不能事先存在。來源封包包含全部七份原始輸入封包，可在不重新下載這些輸入的情況下重建。建置工具仍須安裝；其確切版本與著作權文件保存在 `configuration/toolchain.txt` 及 `licenses/toolchain/`。

流程不套用任何上游原始碼修補。產生的建置檔案與編譯器旗標保存在 `configuration/`。`build.sh` 會依選定的工作目錄，重新產生含安裝前綴路徑的檔案。runtime 與來源封包都包含相同的來源清單與建置資訊；`build-receipt.json` 以 SHA-256 將兩個封包關聯起來。`windows-verification.json` 記錄實際執行結果。

執行檔採 GPL-3.0-or-later 授權。來源封包依 GPL 第 6(d) 節隨二進位檔案提供。未修改的通用工具與 Windows 系統函式庫不屬於此應用程式的來源封包。適用的聲明，包括編譯器 runtime 例外條款，均予以保留。FreeType 依 FreeType License 使用。此建置不會變更 UFriend 獨立 App 的授權。
