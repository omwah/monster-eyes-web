#!/usr/bin/env python3
"""Build Monster Eyes into pages that need no server and no install.

    python3 tools/build.py [--target all|simple|customizable|web] [--eyes DIR] [--out FILE]
    python3 tools/build.py --release

Three targets, all from the same src/:

  simple        dist/monster-eyes-simple.html. One file with every eye package
                built in, and no way to import more. It just runs.
  customizable  dist/monster-eyes-customizable.html. One small file with no
                eyes in it; the viewer adds eye folders, which the browser
                keeps.
  web           dist/web/. A small index.html, with each eye package in its own
                script under eyes/, loaded as the page needs it, plus importing.
                What the website serves; it also works from a folder or zip.

all (the default) builds the three. --out names the file for a single
simple or customizable build.

An eye package is any directory under --eyes (default: eyes/) holding a
config.eye. Its config.eye and bitmaps go in, along with any lids or
textures its config names from another folder. Sounds are left out: the
browser version is silent.

Every build is stamped with the version from package.json. Built from
anything but the commit tagged v<version>, it also carries the commit:
"1.2.0+g1a2b3c4", with ".dirty" after it for uncommitted changes.

--release builds all three, then puts what a release ships in
dist/release/: the two single files, the web version and the eye packages
as zips, and SHA256SUMS. The zips come out the same for the same source.

A build of the project's own eyes also writes build/eyes-data.js, which
src/index.html loads, so the unbundled page can be opened straight from src/
while working on it.

Standard library only.
"""

import argparse
import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
KEEP = (".eye", ".bmp")
REPO = "https://github.com/omwah/monster-eyes-web"
OUTPUTS = {
    "simple": ROOT / "dist" / "monster-eyes-simple.html",
    "customizable": ROOT / "dist" / "monster-eyes-customizable.html",
    "web": ROOT / "dist" / "web",
}
RELEASE = ROOT / "dist" / "release"


ASSET_KEYS = ("irisTexture", "scleraTexture", "upperEyelid", "lowerEyelid")


def git(*args):
    """A git command's output, or None outside a checkout or without git."""
    try:
        out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.strip()


def version() -> str:
    base = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    sha = git("rev-parse", "--short=7", "HEAD")
    if sha is None:
        return base  # A source download: nothing to tell it apart by
    dirty = ".dirty" if git("status", "--porcelain", "--untracked-files=no") else ""
    if f"v{base}" in (git("tag", "--points-at", "HEAD") or "").split() and not dirty:
        return base
    return f"{base}+g{sha}{dirty}"


def strip_comments(text: str) -> str:
    """Drop // and /* */ comments from config.eye, leaving strings alone."""
    out, i, n, quote = [], 0, len(text), None
    while i < n:
        c = text[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == quote:
                quote = None
        elif c in "\"'":
            quote = c
            out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    return "".join(out)


def asset_refs(config_text: str):
    """Every texture and eyelid name a config mentions, root or per-eye."""
    text = strip_comments(config_text)
    pattern = r"[\"']?(%s)[\"']?\s*:\s*[\"']([^\"']+)[\"']" % "|".join(ASSET_KEYS)
    return sorted({m.group(2) for m in re.finditer(pattern, text)})


def normalize(path: str) -> str:
    """Forward slashes, no "." segments, ".." folded where it can be."""
    out = []
    for part in path.replace("\\", "/").split("/"):
        if not part or part == ".":
            continue
        if part == ".." and out and out[-1] != "..":
            out.pop()
        else:
            out.append(part)
    return "/".join(out)


def package_relative(ref: str, pkg_id: str) -> str:
    """The name the renderer looks a file up by, as copyAssetPath() makes it:
    relative to the package, with a leading "<pkg_id>/" dropped."""
    if ref.startswith("/"):
        return normalize(ref)
    head, sep, rest = ref.partition("/")
    if sep and head == pkg_id:
        ref = rest
    return normalize(ref)


def external_assets(pkg_dir: Path, eyes_dir: Path, have: set):
    """Files a package's config names from outside its own folder, keyed by the
    name the renderer will look for. Tried against the package directory (so
    ".." works), then the directory holding the packages (Adafruit's
    "demon/upper.bmp"), then the eyes root. Nothing outside the eyes root is
    taken. Returns (found, missing)."""
    found, missing = {}, []
    root = eyes_dir.resolve()
    for ref in asset_refs((pkg_dir / "config.eye").read_text(encoding="utf-8", errors="replace")):
        rel = package_relative(ref, pkg_dir.name)
        if rel.lower() in have:
            continue
        hit = None
        for base in (pkg_dir, pkg_dir.parent, eyes_dir):
            cand = (base / rel).resolve()
            if cand.is_file() and cand.is_relative_to(root) and cand.suffix.lower() in KEEP:
                hit = cand
                break
        if hit:
            found[rel] = hit
        else:
            missing.append(ref)
    return found, missing


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
        # Lids or textures kept in another folder travel with the package.
        found, missing = external_assets(pkg_dir, eyes_dir, {k.lower() for k in files})
        for rel, f in found.items():
            files[rel] = base64.b64encode(f.read_bytes()).decode("ascii")
        for ref in missing:
            print(f"warning: {pkg_dir.name}: {ref} not found", file=sys.stderr)
        packages.append({"id": pkg_dir.name, "files": files})
    return packages


def bundle_js(packages) -> str:
    data = json.dumps({"packages": packages}, separators=(",", ":"))
    return "window.MONSTER_EYES_BUNDLE = " + data + ";\n"


def inline_safe(js: str) -> str:
    # A literal "</script" would close the inline element early.
    return re.sub(r"</(script)", r"<\\/\1", js, flags=re.IGNORECASE)


def page(variant: str, ver: str, data_scripts) -> str:
    """index.html with the stylesheet and scripts inlined: the variant flag,
    then any data scripts, then the code."""
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    flags = (f"window.MONSTER_EYES_VARIANT = {json.dumps(variant)};\n"
             f"window.MONSTER_EYES_VERSION = {json.dumps(ver)};\n")
    scripts = [flags] + list(data_scripts) + [
        (SRC / name).read_text(encoding="utf-8")
        for name in re.findall(r'<script src="([\w.-]+\.js)"></script>', html)
    ]
    html = re.sub(r"<!-- build:css -->.*?<!-- /build:css -->",
                  lambda _: "<style>\n" + css + "</style>", html, flags=re.S)
    html = re.sub(r"<!-- build:js -->.*?<!-- /build:js -->",
                  lambda _: "\n".join("<script>\n" + inline_safe(s) + "</script>" for s in scripts),
                  html, flags=re.S)
    # The MIT notice travels with every copy, and this file is a copy.
    notice = (ROOT / "LICENSE").read_text(encoding="utf-8").replace("--", "- -")
    return html.replace("<head>", f"<head>\n<!--\nMonster Eyes for the browser {ver} ({variant}): "
                        f"{REPO}\n\n" + notice + "-->", 1)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def shown(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def build_web(packages, out_dir: Path, ver: str) -> None:
    """index.html plus one script per package, named by a hash of its
    contents so it can be cached for good. The manifest in the page lists
    them in order, so every eye can be named before any has arrived."""
    eyes_dir = out_dir / "eyes"
    if eyes_dir.exists():
        shutil.rmtree(eyes_dir)  # Old hashed files would only pile up
    manifest = []
    for pkg in packages:
        # No version in here: the file name would change with every commit.
        body = (f"/* Monster Eyes eye package {json.dumps(pkg['id'])}: {REPO} (MIT) */\n"
                f"MonsterEyes.registerPackage({json.dumps(pkg, separators=(',', ':'))});\n")
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:10]
        safe = re.sub(r"[^\w.-]+", "_", pkg["id"])
        name = f"eyes/{safe}.{digest}.js"
        write(out_dir / name, body)
        manifest.append({"id": pkg["id"], "file": name, "bytes": len(body)})
    data = "window.MONSTER_EYES_MANIFEST = " + json.dumps(manifest, separators=(",", ":")) + ";\n"
    write(out_dir / "index.html", page("web", ver, [data]))


EYES_README = """Monster Eyes eye packages {ver}
{repo}

Each folder holding a config.eye is one eye package: the config and its
.bmp pictures. Some packages borrow lids from a folder beside them, so keep
the folders together.

To use them, open the customizable or web version, choose Add eyes..., and
pick this folder (or any one package inside it). The browser keeps them for
next time.

Credits for the eyes are in the project's README.
"""


def zip_write(zf: zipfile.ZipFile, name: str, data: bytes) -> None:
    """One entry, with a fixed date and mode, so a zip depends only on its
    contents."""
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.external_attr = 0o644 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    zf.writestr(info, data, compresslevel=9)


def zip_tree(out: Path, top: str, src: Path, files, extra=()) -> None:
    """files under src, and (name, bytes) extras, inside a folder named top."""
    entries = {f"{top}/{f.relative_to(src).as_posix()}": f.read_bytes() for f in files}
    entries.update({f"{top}/{name}": data for name, data in extra})
    with zipfile.ZipFile(out, "w") as zf:
        for name in sorted(entries):
            zip_write(zf, name, entries[name])


def release(eyes_dir: Path, ver: str) -> None:
    if RELEASE.exists():
        shutil.rmtree(RELEASE)
    RELEASE.mkdir(parents=True)
    licence = (ROOT / "LICENSE").read_bytes()
    made = []
    for target in ("simple", "customizable"):
        out = RELEASE / f"monster-eyes-{target}-{ver}.html"
        shutil.copyfile(OUTPUTS[target], out)
        made.append(out)

    web = OUTPUTS["web"]
    out = RELEASE / f"monster-eyes-web-{ver}.zip"
    zip_tree(out, f"monster-eyes-web-{ver}", web, [f for f in web.rglob("*") if f.is_file()],
             [("LICENSE", licence)])
    made.append(out)

    # The eye packages as they are in eyes/, for adding to the other versions.
    # Only what the browser reads: config.eye and the pictures.
    eyes = [f for f in eyes_dir.rglob("*")
            if f.is_file() and f.suffix.lower() in KEEP
            and not any(p.startswith(".") for p in f.relative_to(eyes_dir).parts)]
    out = RELEASE / f"monster-eyes-eyes-{ver}.zip"
    readme = EYES_README.format(ver=ver, repo=REPO).encode("utf-8")
    zip_tree(out, f"monster-eyes-eyes-{ver}", eyes_dir, eyes,
             [("README.txt", readme), ("LICENSE", licence)])
    made.append(out)

    sums = "".join(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in made)
    (RELEASE / "SHA256SUMS").write_text(sums, encoding="utf-8")
    for f in made:
        print(f"release: {shown(f)} ({f.stat().st_size / 1e6:.1f} MB)")
    print(f"release: {shown(RELEASE / 'SHA256SUMS')}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--target", choices=["all", "simple", "customizable", "web"], default="all")
    ap.add_argument("--eyes", type=Path, default=ROOT / "eyes", help="directory of eye packages")
    ap.add_argument("--out", type=Path, help="output file, for a single simple or customizable build")
    ap.add_argument("--release", action="store_true", help="build all three and package them in dist/release/")
    args = ap.parse_args()
    if args.release and (args.out or args.target != "all"):
        ap.error("--release builds every target, to the usual places")
    if args.out and args.target not in ("simple", "customizable"):
        ap.error("--out needs --target simple or --target customizable")

    ver = version()
    print(f"Monster Eyes {ver}")
    targets = ["simple", "customizable", "web"] if args.target == "all" else [args.target]
    packages = []
    if any(t != "customizable" for t in targets):
        packages = find_packages(args.eyes)
        if not packages:
            print(f"No eye packages (directories with a config.eye) under {args.eyes}", file=sys.stderr)
            return 1

    for target in targets:
        if target == "web":
            out = OUTPUTS["web"]
            build_web(packages, out, ver)
            size = (out / "index.html").stat().st_size / 1e3
            print(f"web: {len(packages)} eye packages -> {shown(out)}/ (index.html {size:.0f} KB)")
            continue
        out = args.out or OUTPUTS[target]
        data = [bundle_js(packages)] if target == "simple" else []
        write(out, page(target, ver, data))
        size = out.stat().st_size / 1e6
        print(f"{target}: {len(packages) if target == 'simple' else 'no'} eye packages -> {shown(out)} ({size:.1f} MB)")

    # The dev page's data only comes from the project's own eyes, so a build
    # from some other folder (a test fixture, say) leaves it alone.
    if packages and args.eyes.resolve() == (ROOT / "eyes").resolve():
        dev = ROOT / "build" / "eyes-data.js"
        write(dev, bundle_js(packages))
        print(f"dev data -> {shown(dev)}")
    if args.release:
        release(args.eyes, ver)
    return 0


if __name__ == "__main__":
    sys.exit(main())
