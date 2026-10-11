#!/usr/bin/env python3
"""Fetch immutable inputs, inspect PE imports, and package runtime/source peers."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile

RECIPE = Path(__file__).resolve().parent
LOCK = json.loads((RECIPE / "sources.lock.json").read_text(encoding="utf-8"))
VERSION = LOCK["runtimeVersion"]
SYSTEM_DLLS = {
    "advapi32.dll", "avicap32.dll", "avrt.dll", "bcrypt.dll", "combase.dll", "crypt32.dll",
    "d3d9.dll", "d3d11.dll", "d3d12.dll", "dwrite.dll", "dxgi.dll", "dxva2.dll", "gdi32.dll",
    "kernel32.dll", "mf.dll", "mfplat.dll", "mfreadwrite.dll", "msacm32.dll", "msvcrt.dll", "msvfw32.dll",
    "ntdll.dll", "ole32.dll", "oleaut32.dll", "psapi.dll", "secur32.dll",
    "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll", "version.dll",
    "winmm.dll", "ws2_32.dll",
}


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_write(file, value):
    Path(file).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def record(file):
    file = Path(file)
    return {"name": file.name, "bytes": file.stat().st_size, "sha256": digest(file)}


def fetch(work, cache):
    downloads, sources = work / "downloads", work / "src"
    downloads.mkdir()
    sources.mkdir()
    for entry in LOCK["sources"]:
        name = entry["file"]
        if Path(name).name != name or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]):
            raise ValueError("Invalid source lock entry")
        archive = downloads / name
        if cache:
            shutil.copyfile(Path(cache) / name, archive)
        else:
            subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--retry-all-errors",
                            "--connect-timeout", "30", "--max-time", "600",
                            "--output", str(archive), entry["url"]], check=True)
        if digest(archive) != entry["sha256"]:
            raise ValueError(f"Source SHA-256 mismatch: {name}")
        unpack = sources / (entry["name"] + "-unpack")
        unpack.mkdir()
        with tarfile.open(archive) as source_tar:
            source_tar.extractall(unpack, filter="data")
        roots = list(unpack.iterdir())
        if len(roots) != 1 or not roots[0].is_dir() or roots[0].is_symlink():
            raise ValueError(f"Unexpected source archive layout: {name}")
        roots[0].rename(sources / entry["name"])
        unpack.rmdir()
        print(f"Verified source {entry['name']} {entry['version']}", flush=True)


def package(work, output):
    payload = output / f"ffmpeg-{VERSION}-win64"
    binary_dir = payload / "bin"
    binary_dir.mkdir(parents=True)
    imports = {}
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        source = work / "prefix" / "bin" / name
        details = subprocess.check_output(["x86_64-w64-mingw32-objdump", "-p", str(source)], text=True)
        if "pei-x86-64" not in details:
            raise ValueError(f"Not a Windows x64 PE: {name}")
        libraries = sorted(set(re.findall(r"DLL Name:\s*(\S+)", details)))
        if not libraries:
            raise ValueError(f"Missing PE import table: {name}")
        for library in libraries:
            lowered = library.lower()
            if lowered not in SYSTEM_DLLS and not re.fullmatch(r"api-ms-win-crt-[a-z0-9-]+\.dll", lowered):
                raise ValueError(f"Non-system DLL dependency in {name}: {library}")
        imports[name] = libraries
        shutil.copyfile(source, binary_dir / name)

    notices = [
        "UFriend FFmpeg runtime third-party notices\n",
        "This binary includes FreeType software. FreeType is used under the FreeType License.\n",
        "All pinned upstream source archives retain their original copyright notices.\n",
    ]
    license_dir = payload / "licenses"
    for entry in LOCK["sources"]:
        for relative in entry["licenseFiles"]:
            original = work / "src" / entry["name"] / relative
            if not original.is_file():
                raise ValueError(f"Required upstream license missing: {entry['name']}/{relative}")
            target = license_dir / entry["name"] / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            notices += [f"\n{'=' * 72}\n{entry['name']} {entry['version']} — {relative}\n{'=' * 72}\n",
                        original.read_text(encoding="utf-8", errors="replace") + "\n"]
    for original in sorted((work / "toolchain-licenses").glob("*.txt")):
        target = license_dir / "toolchain" / original.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
        notices += [f"\n{'=' * 72}\nToolchain/runtime notice — {original.name}\n{'=' * 72}\n",
                    original.read_text(encoding="utf-8", errors="replace") + "\n"]
    (payload / "THIRD_PARTY_LICENSES.txt").write_text("".join(notices), encoding="utf-8")
    shutil.copyfile(work / "src" / "ffmpeg" / "COPYING.GPLv3", payload / "COPYING.GPLv3.txt")
    shutil.copyfile(RECIPE / "sources.lock.json", payload / "SOURCE_INVENTORY.json")
    source_name = f"FFmpeg-{VERSION}-corresponding-source.tar.xz"
    summary = (
        f"FFmpeg {VERSION}, Windows x64, built for UFriend.\n"
        "This is a UFriend build from upstream source, not a Gyan binary.\n"
        "FFmpeg and its selected libraries are statically linked; only Windows system DLLs are required.\n"
        "Includes libass with DirectWrite/GDI, FreeType, FriBidi, HarfBuzz, x264, and LAME.\n"
        "FFmpeg native codecs, containers, and filters remain enabled; AAC uses FFmpeg's native encoder.\n"
        "No external TLS, network protocols, fontconfig, or optional hardware SDKs are enabled.\n"
        "License: GNU GPL version 3 or later for this FFmpeg executable; see COPYING.GPLv3.txt.\n"
        "UFriend invokes the executable as a separate command-line process.\n"
        f"Corresponding source is distributed as {source_name} alongside this runtime.\n"
        "The source package contains every pinned application/library input archive, the build recipe,\n"
        "and the generated configuration. General-purpose unmodified tools and Windows system libraries\n"
        "are not included; toolchain versions and applicable runtime notices are recorded.\n"
        "No warranty. See the supplied licenses.\n"
    )
    (payload / "UPSTREAM-README.txt").write_text(summary, encoding="utf-8")
    (payload / "SOURCES.md").write_text(
        f"# FFmpeg {VERSION} corresponding source\n\n"
        f"Download `{source_name}` from the same release as this runtime.\n\n"
        "The archive contains `sources/` (the actual SHA-256-verified input archives), `recipe/`, "
        "`configuration/`, and `licenses/`. `SOURCE_INVENTORY.json` identifies every selected library. "
        "See `recipe/README.md` to rebuild without downloading those inputs again.\n\n"
        "The build does not use third-party binary libraries. The unmodified compiler/build tools and "
        "Windows system libraries are outside this application's source bundle; exact installed compiler "
        "versions and compiler/runtime notices are included.\n\n"
        "FFmpeg licensing: https://ffmpeg.org/legal.html\n"
        "GPL terms: https://www.gnu.org/licenses/gpl-3.0.html\n",
        encoding="utf-8",
    )
    source_root = work / f"FFmpeg-{VERSION}-corresponding-source"
    source_root.mkdir()
    shutil.copytree(work / "downloads", source_root / "sources")
    shutil.copytree(RECIPE, source_root / "recipe", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    guide = RECIPE / "README.md"
    if not guide.is_file():
        guide = RECIPE.parents[2] / "docs" / "development" / "MEDIA_RUNTIME_BUILD.md"
    shutil.copyfile(guide, source_root / "recipe" / "README.md")
    shutil.copytree(work / "configuration", source_root / "configuration")
    shutil.copytree(license_dir, source_root / "licenses")
    for filename in ("COPYING.GPLv3.txt", "UPSTREAM-README.txt", "SOURCES.md", "SOURCE_INVENTORY.json"):
        shutil.copyfile(payload / filename, source_root / filename)
    # Configuration paths identify the build prefix but do not require that same
    # path on a recipient's machine; build.sh regenerates them for its new prefix.
    build_info = {
        "schemaVersion": 1, "version": VERSION, "target": LOCK["target"],
        "recipeCommit": os.environ.get("GITHUB_SHA", "local-uncommitted"),
        "ffmpegSourceRevision": LOCK["sources"][0]["revision"],
        "sourceInventorySha256": digest(RECIPE / "sources.lock.json"),
        "peImports": imports,
        "binaries": {name: record(binary_dir / name) for name in imports},
        "sourceInputs": [{**entry, "bytes": (work / "downloads" / entry["file"]).stat().st_size}
                         for entry in LOCK["sources"]],
        "patches": [],
    }
    json_write(payload / "BUILD_INFO.json", build_info)
    json_write(source_root / "BUILD_INFO.json", build_info)
    archive = output / source_name
    with tarfile.open(archive, "w:xz", preset=6) as source_tar:
        source_tar.add(source_root, arcname=source_root.name)
    if archive.stat().st_size >= 2_000_000_000:
        raise ValueError("Source archive exceeds the release asset limit")
    runtime_zip = output / f"ffmpeg-{VERSION}-win64.zip"
    with zipfile.ZipFile(runtime_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as runtime:
        for file in sorted(payload.rglob("*")):
            if file.is_file():
                runtime.write(file, file.relative_to(payload.parent))
    json_write(output / "build-receipt.json", {
        "schemaVersion": 1, "result": "BUILT", "runtime": build_info,
        "runtimeArchive": record(runtime_zip), "sourceArchive": record(archive),
        "checks": {"allPinnedInputsVerified": True, "allRequiredNoticesPresent": True,
                   "windowsX64Pe": True, "systemDllImportsOnly": True,
                   "sourceContainsInputsRecipeAndConfiguration": True},
        "requiresWindowsExecutionVerification": True,
    })
    print(json.dumps({"runtime": str(runtime_zip), "source": str(archive)}, indent=2))


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] not in {"fetch", "package"}:
        raise SystemExit("Usage: package.py fetch WORK CACHE | package.py package WORK OUTPUT")
    if sys.argv[1] == "fetch":
        fetch(Path(sys.argv[2]), sys.argv[3])
    else:
        package(Path(sys.argv[2]), Path(sys.argv[3]))
