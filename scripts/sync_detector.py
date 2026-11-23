#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Wolfray Applied Technologies, LLC
"""Copy the on-device detector's code into src/detector/ again, and say which files changed.

    python3 scripts/sync_detector.py [--from DIR] [--check]

The detector's code (the WebGPU engine, its backend, the landmark path and the helpers it needs) is written and tested
in the detector's own repository (default ~/spine_detect, or SPINE_DETECT=DIR). Each file is copied unchanged, with
this app's licence header added in front. Before copying, every file whose body (the copy without that header) differs
from its source is listed, with the number of lines that differ; --check lists only and exits with 1 if any differs.
No trained numbers are copied: the network and its numbers come in the detector file, which is not part of this
repository.
"""
import argparse
import difflib
import os
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
HEADER = (
    "// SPDX-License-Identifier: GPL-3.0-only\n"
    "// Copyright (C) 2026 Wolfray Applied Technologies, LLC\n"
    "// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.\n"
)
# app file -> source file (relative to the detector's repository)
FILES = {
    "src/detector/combo.mjs": "phone/web/js/combo.mjs",
    "src/detector/img.mjs": "phone/web/js/img.mjs",
    "src/detector/order.mjs": "phone/web/js/order.mjs",
    "src/detector/decode.mjs": "phone/web/js/decode.mjs",
    "src/detector/backend-engine.mjs": "phone/web/js/backend-engine.mjs",
    "src/detector/hand/engine.mjs": "phone/engine15/js/engine.mjs",
    "src/detector/hand/backend-hand.mjs": "phone/engine15/js/backend-hand.mjs",
}


def body(text):
    """A copy without the header this script adds."""
    return text[len(HEADER):] if text.startswith(HEADER) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="src", default=os.environ.get("SPINE_DETECT", str(Path.home() / "spine_detect")))
    ap.add_argument("--check", action="store_true", help="only list the files that differ; change nothing")
    a = ap.parse_args()
    src = Path(a.src).expanduser()
    missing = [s for s in FILES.values() if not (src / s).is_file()]
    if missing:
        sys.exit("not found in %s: %s" % (src, ", ".join(missing)))
    differ = 0
    for mine, theirs in FILES.items():
        new = (src / theirs).read_text()
        path = APP / mine
        old = body(path.read_text()) if path.is_file() else None
        if old is None:
            state = "new" if not path.is_file() else "its header is not the one this script writes"
        elif old == new:
            state = "the same"
        else:
            lines = sum(1 for d in difflib.ndiff(old.splitlines(), new.splitlines()) if d[:1] in "+-")
            state = "DIFFERS from its source (%d lines)" % lines
        if state != "the same":
            differ += 1
        print("%-36s %s" % (mine, state))
        if not a.check and state != "the same":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(HEADER + new)
    if a.check:
        print("%d of %d files differ from %s" % (differ, len(FILES), src))
        sys.exit(1 if differ else 0)
    print("%d of %d files copied again from %s" % (differ, len(FILES), src))


if __name__ == "__main__":
    main()
