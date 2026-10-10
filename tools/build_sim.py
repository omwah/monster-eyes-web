#!/usr/bin/env python3
"""Build the C++ reference renderer (eye-sim) that tests/parity.mjs compares against.

    python3 tools/build_sim.py --sim /path/to/sim
    MONSTER_EYES_SIM=/path/to/sim python3 tools/build_sim.py

--sim (or MONSTER_EYES_SIM) is the eye-sim source directory: the one with its
CMakeLists.txt, inside a checkout of the C++ Monster Eyes fork. Nothing in
that checkout is written to; the build goes to vendor/sim-build, and
ArduinoJson, which it needs, is fetched into vendor/ArduinoJson.

Needs cmake, a C++ compiler, zlib and git: `pixi run build-sim` provides them.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
ARDUINOJSON_TAG = "v7.4.3"


def run(cmd):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sim", default=os.environ.get("MONSTER_EYES_SIM"),
                    help="eye-sim source directory (default: $MONSTER_EYES_SIM)")
    args = ap.parse_args()

    if not args.sim:
        print("Where is the eye-sim source? Pass --sim DIR or set MONSTER_EYES_SIM.",
              file=sys.stderr)
        return 2
    sim = Path(args.sim).expanduser().resolve()
    if not (sim / "CMakeLists.txt").is_file():
        print(f"{sim} has no CMakeLists.txt; --sim should name the eye-sim source directory.",
              file=sys.stderr)
        return 2

    arduinojson = VENDOR / "ArduinoJson"
    if not arduinojson.is_dir():
        run(["git", "clone", "-q", "--depth", "1", "--branch", ARDUINOJSON_TAG,
             "https://github.com/bblanchon/ArduinoJson", arduinojson])

    configure = ["cmake", "-S", sim, "-B", VENDOR / "sim-build", "-DCMAKE_BUILD_TYPE=Release",
                 f"-DARDUINOJSON_DIR={arduinojson / 'src'}"]
    # The sim includes config_doc.h only when SDL3 is found, so its headless
    # build does not compile without help.
    config_doc = sim / "src" / "config_doc.h"
    if config_doc.is_file():
        configure.append(f"-DCMAKE_CXX_FLAGS=-include {config_doc}")
    run(configure)
    run(["cmake", "--build", VENDOR / "sim-build", "-j"])
    print(f"Built {VENDOR / 'sim-build' / 'eye-sim'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
