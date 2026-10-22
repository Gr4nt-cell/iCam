"""Play requirement check: every 64-bit native library must be 16 KB page compatible
(ELF LOAD segments aligned to >= 16 KB, and uncompressed .so entries 16 KB-aligned in the zip)."""
import struct
import sys
import zipfile

apk = sys.argv[1]
bad = []
checked = 0
with zipfile.ZipFile(apk) as z:
    for info in z.infolist():
        n = info.filename
        if not n.endswith('.so') or not (n.startswith('lib/arm64-v8a/') or n.startswith('lib/x86_64/')):
            continue
        checked += 1
        data = z.read(n)
        if data[:4] != b'\x7fELF' or data[4] != 2:
            continue
        phoff = struct.unpack_from('<Q', data, 0x20)[0]
        phentsize, phnum = struct.unpack_from('<HH', data, 0x36)
        aligns = []
        for i in range(phnum):
            off = phoff + i * phentsize
            p_type = struct.unpack_from('<I', data, off)[0]
            if p_type == 1:  # PT_LOAD
                aligns.append(struct.unpack_from('<Q', data, off + 0x30)[0])
        elf_ok = all(a >= 16384 for a in aligns)
        zip_ok = True
        if info.compress_type == zipfile.ZIP_STORED:
            # data offset = header offset + 30 + name + extra (local header)
            with open(apk, 'rb') as f:
                f.seek(info.header_offset + 26)
                nlen, elen = struct.unpack('<HH', f.read(4))
            zip_ok = (info.header_offset + 30 + nlen + elen) % 16384 == 0
        if not (elf_ok and zip_ok):
            bad.append(f"{n} (ELF align {min(aligns) if aligns else '?'}{'' if zip_ok else ', zip offset not 16 KB aligned'})")

print(f"checked {checked} libraries; not 16 KB compatible: {len(bad)}")
for b in bad:
    print("  " + b)
sys.exit(1 if bad else 0)
