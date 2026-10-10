#!/usr/bin/env python3
"""Package Monster Eyes into one self-contained HTML file.

    python3 tools/build.py [--eyes DIR] [--out FILE]

Reads every eye package under eyes/ (any directory holding a config.eye),
embeds its config.eye and bitmaps as base64, inlines the stylesheet and
scripts from src/, and writes dist/monster-eyes.html. That file needs nothing
else: double-click it, email it, put it on a USB stick.

It also writes build/eyes-data.js, which src/index.html loads, so the
unbundled page can be opened straight from src/ while working on it.

Standard library only. Sounds are left out: the browser version is silent.
"""

import argparse
import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
KEEP = (".eye", ".bmp")


def find_packages(eyes_dir: Path):
    packages = []
    for config in sorted(eyes_dir.rglob("config.eye")):
        pkg_dir = config.parent
        if any(part.startswith(".") for part in pkg_dir.relative_to(eyes_dir).parts):
            continue
        files = {}
        for f in sorted(pkg_dir.rglob("*")):
            rel = f.relative_to(pkg_dir)
            if not f.is_file() or f.suffix.lower() not in KEEP:
                continue
            # A nested package belongs to itself, not to this one.
            if any((pkg_dir / p / "config.eye").exists() for p in rel.parents if str(p) != "."):
                continue
            files[rel.as_posix()] = base64.b64encode(f.read_bytes()).decode("ascii")
        packages.append({"id": pkg_dir.name, "files": files})
    return packages


def bundle_js(packages) -> str:
    data = json.dumps({"packages": packages}, separators=(",", ":"))
    return "window.MONSTER_EYES_BUNDLE = " + data + ";\n"


def inline_safe(js: str) -> str:
    # A literal "</script" would close the inline element early.
    return re.sub(r"</(script)", r"<\\/\1", js, flags=re.IGNORECASE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--eyes", type=Path, default=ROOT / "eyes", help="directory of eye packages")
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "monster-eyes.html")
    args = ap.parse_args()

    packages = find_packages(args.eyes)
    if not packages:
        print(f"No eye packages (directories with a config.eye) under {args.eyes}", file=sys.stderr)
        return 1
    data_js = bundle_js(packages)

    dev = ROOT / "build" / "eyes-data.js"
    dev.parent.mkdir(parents=True, exist_ok=True)
    dev.write_text(data_js, encoding="utf-8")

    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    scripts = [data_js] + [
        (SRC / name).read_text(encoding="utf-8")
        for name in re.findall(r'<script src="([\w.-]+\.js)"></script>', html)
    ]
    html = re.sub(r"<!-- build:css -->.*?<!-- /build:css -->",
                  lambda _: "<style>\n" + css + "</style>", html, flags=re.S)
    html = re.sub(r"<!-- build:js -->.*?<!-- /build:js -->",
                  lambda _: "\n".join("<script>\n" + inline_safe(s) + "</script>" for s in scripts),
                  html, flags=re.S)

    # The MIT notice travels with every copy, and this file is the copy.
    notice = (ROOT / "LICENSE").read_text(encoding="utf-8").replace("--", "- -")
    html = html.replace("<head>", "<head>\n<!--\nMonster Eyes for the browser: "
                        "https://github.com/omwah/monster-eyes-web\n\n" + notice + "-->", 1)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(html, encoding="utf-8")
    size = args.out.stat().st_size / 1e6
    print(f"{len(packages)} eye packages -> {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out} ({size:.1f} MB)")
    print(f"dev data -> {dev.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
