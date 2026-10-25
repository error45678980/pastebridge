#!/usr/bin/env python3
"""打包 Edge Add-ons 提交包。

用法：python store/build-package.py
输出：store/package/pastebridge-<version>-edge.zip

只收运行时需要的文件：manifest.json 必须在 zip 根目录，
node_modules / demo / tests / tools / store 一律不进包。
"""

import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "store", "package")

# (源路径, zip 内路径)
ITEMS = [
    ("manifest.json", "manifest.json"),
    ("LICENSE", "LICENSE"),
    ("icons", "icons"),
    ("popup", "popup"),
    ("page", "page"),
    ("background", "background"),
    ("lib", "lib"),
    ("workbench", "workbench"),
]

# 包里允许出现的扩展名（防止把 .map / 备份文件带进去）
ALLOWED_EXT = {".json", ".js", ".html", ".css", ".png", ".svg", ".txt", ""}


def collect():
    files = []
    for src, dest in ITEMS:
        path = os.path.join(ROOT, src)
        if os.path.isfile(path):
            files.append((path, dest))
            continue
        for base, _dirs, names in os.walk(path):
            for name in sorted(names):
                full = os.path.join(base, name)
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
                    print("  skip  " + rel)
                    continue
                files.append((full, rel))
    return files


def main():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest["version"]

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "pastebridge-%s-edge.zip" % version)
    files = collect()

    # zipfile 的默认时间戳取文件 mtime，逐文件不同会让包不可复现；
    # 固定成同一个时间点，同样的输入永远产出同样的包。
    stamp = (2024, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in files:
            info = zipfile.ZipInfo(rel, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read())

    size = os.path.getsize(out)
    print("\n打包完成：%s" % out)
    print("版本 %s · %d 个文件 · %.1f KB\n" % (version, len(files), size / 1024))

    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        names = z.namelist()
        print("%-34s %8s" % ("文件", "大小"))
        print("-" * 46)
        for info in z.infolist():
            print("%-34s %7d B" % (info.filename, info.file_size))

    assert bad is None, "zip 校验失败: %s" % bad
    assert "manifest.json" in names, "manifest.json 不在 zip 根目录"
    assert not any(n.startswith(("node_modules/", "demo/", "tests/", "store/")) for n in names), \
        "包里混进了不该提交的目录"
    print("\n✓ manifest.json 位于根目录，无冗余目录")


if __name__ == "__main__":
    main()
