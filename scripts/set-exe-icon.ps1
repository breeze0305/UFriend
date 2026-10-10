[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$IconPath,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$iconProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$iconTarget = (Get-Item -LiteralPath $ExecutablePath).FullName
$iconSource = (Get-Item -LiteralPath $IconPath).FullName
$iconDistRoot = Join-Path $iconProjectRoot 'dist'
$iconTestRoot = Join-Path $iconProjectRoot '.test-data\icon'
$iconTargetDirectory = [IO.Path]::GetDirectoryName($iconTarget)
$iconIsTest = $iconTarget.StartsWith(($iconTestRoot + '\'), [StringComparison]::OrdinalIgnoreCase)
$iconIsPackage = [IO.Path]::GetDirectoryName($iconTargetDirectory).Equals($iconDistRoot, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath (Join-Path $iconTargetDirectory '.ufriend-package-output') -PathType Leaf) -and
    ([IO.Path]::GetFileName($iconTarget) -eq 'UFriend.exe')
if ((-not $iconIsTest -and -not $iconIsPackage) -or [IO.Path]::GetExtension($iconTarget) -ne '.exe') {
    throw 'Icon embedding is restricted to a generated package EXE or .test-data/icon fixture.'
}
# A junction or symlink must never redirect a build mutation into the runtime or another folder.
$iconAncestor = $iconTarget
while ($iconAncestor -and -not $iconAncestor.Equals($iconProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if (((Get-Item -Force -LiteralPath $iconAncestor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Icon embedding refuses reparse points in the output path.'
    }
    $iconAncestor = [IO.Path]::GetDirectoryName($iconAncestor)
}

# Microsoft resource format: https://devblogs.microsoft.com/oldnewthing/20120720-00/?p=7083
# Updates preserve all other resource types; only EndUpdateResource(false) commits.
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-updateresourcew
if (-not ('UFriendBuild.ExeIcon' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace UFriendBuild {
    public static class ExeIcon {
        private const ushort IconType = 3, GroupType = 14;
        private sealed class Resource {
            public ushort Type, Language;
            public int Id = -1;
            public string Name;
            public byte[] Data;
            public string Key { get { return Type + ":" + (Id >= 0 ? "#" + Id : "@" + Name) + ":" + Language; } }
            public IntPtr NamePointer() { return Id >= 0 ? new IntPtr(Id) : Marshal.StringToHGlobalUni(Name); }
            public void FreeName(IntPtr value) { if (Id < 0) Marshal.FreeHGlobal(value); }
        }
        private delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
        private delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool FreeLibrary(IntPtr module);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool EnumResourceNamesExW(IntPtr module, IntPtr type, NameCallback callback, IntPtr param, uint flags, ushort language);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool EnumResourceLanguagesExW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr param, uint flags, ushort language);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern IntPtr LockResource(IntPtr resource);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr BeginUpdateResourceW(string path, bool deleteExisting);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint length);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool EndUpdateResourceW(IntPtr update, bool discard);

        private static Exception NativeError(string operation) {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed.");
        }
        private static List<Resource> ReadResources(string executable) {
            // Map as resources only; do not execute code or load imported DLLs.
            IntPtr module = LoadLibraryExW(executable, IntPtr.Zero, 0x40 | 0x20);
            if (module == IntPtr.Zero) throw NativeError("LoadLibraryEx");
            var result = new List<Resource>();
            try {
                // Verify that manifest and version resources survive alongside the icon replacement.
                foreach (ushort type in new ushort[] { IconType, GroupType, 16, 24 }) {
                    Exception failure = null;
                    NameCallback names = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr unused) {
                        try {
                            bool numeric = ((ulong)n.ToInt64() >> 16) == 0;
                            int id = numeric ? n.ToInt32() : -1;
                            string name = numeric ? null : Marshal.PtrToStringUni(n);
                            LanguageCallback languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort language, IntPtr lp) {
                                try {
                                    IntPtr resource = FindResourceExW(m, t, n, language);
                                    if (resource == IntPtr.Zero) throw NativeError("FindResourceEx");
                                    uint length = SizeofResource(m, resource);
                                    IntPtr loaded = LoadResource(m, resource);
                                    if (loaded == IntPtr.Zero) throw NativeError("LoadResource");
                                    IntPtr data = LockResource(loaded);
                                    if (data == IntPtr.Zero) throw NativeError("LockResource");
                                    byte[] bytes = new byte[checked((int)length)];
                                    Marshal.Copy(data, bytes, 0, bytes.Length);
                                    result.Add(new Resource { Type=type, Id=id, Name=name, Language=language, Data=bytes });
                                    return true;
                                } catch (Exception error) { failure=error; return false; }
                            };
                            // RESOURCE_ENUM_LN searches this file, never an adjacent .mui file.
                            bool ok = EnumResourceLanguagesExW(m, t, n, languages, IntPtr.Zero, 1, 0);
                            if (!ok && failure == null) failure = NativeError("EnumResourceLanguagesEx");
                            return failure == null;
                        } catch (Exception error) { failure=error; return false; }
                    };
                    bool found = EnumResourceNamesExW(module, new IntPtr(type), names, IntPtr.Zero, 1, 0);
                    int code = Marshal.GetLastWin32Error();
                    if (failure != null) throw failure;
                    if (!found && code != 1813 && code != 1812) throw new Win32Exception(code, "EnumResourceNamesEx failed.");
                }
                return result;
            } finally { FreeLibrary(module); }
        }
        private static bool Equal(byte[] left, byte[] right) {
            if (left.Length != right.Length) return false;
            for (int i=0; i<left.Length; i++) if (left[i] != right[i]) return false;
            return true;
        }
        private static void WriteResource(IntPtr update, Resource resource, bool remove) {
            IntPtr name = resource.NamePointer();
            try {
                if (!UpdateResourceW(update, new IntPtr(resource.Type), name, resource.Language,
                    remove ? null : resource.Data, remove ? 0 : checked((uint)resource.Data.Length))) throw NativeError("UpdateResource");
            } finally { resource.FreeName(name); }
        }
        public static string Apply(string executable, string iconPath, bool verifyOnly) {
            byte[] ico = File.ReadAllBytes(iconPath);
            if (ico.Length < 6 || BitConverter.ToUInt16(ico,0) != 0 || BitConverter.ToUInt16(ico,2) != 1)
                throw new InvalidDataException("Expected a Windows ICO file.");
            int count = BitConverter.ToUInt16(ico,4), directoryLength = 6 + count * 16;
            if (count < 1 || count > 256 || directoryLength > ico.Length) throw new InvalidDataException("Invalid ICO directory.");
            var images = new List<byte[]>();
            byte[] group;
            using (var memory = new MemoryStream()) {
                using (var writer = new BinaryWriter(memory)) {
                    writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)count);
                    for (int i=0; i<count; i++) {
                        int entry = 6 + i*16;
                        uint length = BitConverter.ToUInt32(ico,entry+8), offset = BitConverter.ToUInt32(ico,entry+12);
                        if (ico[entry+3] != 0 || length == 0 || offset < directoryLength || (ulong)offset+length > (ulong)ico.Length)
                            throw new InvalidDataException("ICO image range is invalid.");
                        byte[] image = new byte[checked((int)length)];
                        Buffer.BlockCopy(ico, checked((int)offset), image, 0, image.Length);
                        images.Add(image);
                        // GRPICONDIRENTRY is 14 bytes: keep the first 12, replace file offset by WORD nId.
                        writer.Write(ico, entry, 12); writer.Write(checked((ushort)(i+1)));
                    }
                    writer.Flush(); group=memory.ToArray();
                }
            }
            List<Resource> before = ReadResources(executable);
            var desired = new Dictionary<string,Resource>();
            var groups = before.FindAll(r => r.Type == GroupType);
            if (groups.Count == 0) groups.Add(new Resource { Type=GroupType, Id=1, Language=0 });
            var languages = new HashSet<ushort>();
            foreach (Resource original in groups) {
                var replacement = new Resource { Type=GroupType, Id=original.Id, Name=original.Name, Language=original.Language, Data=group };
                desired.Add(replacement.Key,replacement); languages.Add(original.Language);
            }
            foreach (ushort language in languages) for (int i=0; i<count; i++) {
                var image = new Resource { Type=IconType, Id=i+1, Language=language, Data=images[i] };
                desired.Add(image.Key,image);
            }
            if (!verifyOnly) {
                // ReadResources has released its mapping before opening a resource transaction.
                IntPtr update = BeginUpdateResourceW(executable, false);
                if (update == IntPtr.Zero) throw NativeError("BeginUpdateResource");
                bool ended = false;
                try {
                    foreach (Resource old in before) if (old.Type == IconType && !desired.ContainsKey(old.Key)) WriteResource(update,old,true);
                    // Replace every original group/name/language, including named groups Explorer prefers.
                    foreach (Resource resource in desired.Values) WriteResource(update,resource,false);
                    bool committed = EndUpdateResourceW(update,false);
                    int code = Marshal.GetLastWin32Error(); ended=true;
                    if (!committed) throw new Win32Exception(code,"EndUpdateResource failed; do not distribute this build.");
                } finally { if (!ended) EndUpdateResourceW(update,true); }
            }
            List<Resource> after = ReadResources(executable);
            int actualIcons=0;
            foreach (Resource resource in after) if (resource.Type == IconType || resource.Type == GroupType) {
                actualIcons++;
                Resource expected;
                if (!desired.TryGetValue(resource.Key,out expected) || !Equal(resource.Data,expected.Data))
                    throw new InvalidDataException("EXE icon verification failed.");
            }
            if (actualIcons != desired.Count) throw new InvalidDataException("EXE icon resources are incomplete.");
            var retained = new Dictionary<string,byte[]>();
            foreach (Resource resource in before) if (resource.Type != IconType && resource.Type != GroupType) retained.Add(resource.Key,resource.Data);
            foreach (Resource resource in after) if (resource.Type != IconType && resource.Type != GroupType) {
                byte[] expected;
                if (!retained.TryGetValue(resource.Key,out expected) || !Equal(resource.Data,expected))
                    throw new InvalidDataException("EXE manifest/version resources changed unexpectedly.");
                retained.Remove(resource.Key);
            }
            if (retained.Count != 0) throw new InvalidDataException("EXE manifest/version resources are missing.");
            return count + " icon sizes verified across " + groups.Count + " group/language entries; manifest and version preserved.";
        }
    }
}
'@
}

[UFriendBuild.ExeIcon]::Apply($iconTarget, $iconSource, $VerifyOnly.IsPresent)
