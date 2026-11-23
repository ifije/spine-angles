#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Wolfray Applied Technologies, LLC
"""Put a detector file into public/detector/, where the app finds its built-in detector.

    python3 scripts/publish_detector.py DETECTOR_FILE

The file is checked (format "spine-detector/1", its content stamp), copied as public/detector/spine-detector-STAMP.bin
(the first 16 hex digits of its stamp: a new file has a new name, so no browser mixes the two up), and
public/detector/index.json is written to name it, with its size and full stamp. Any other detector file in that folder
is removed. The app downloads the file once, keeps it on the device by its stamp, and downloads it again only when
index.json names a new stamp.
"""
import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "public" / "detector"


def header(data):
    if data[:8] != b"SPINEDET":
        sys.exit("not a detector file")
    (n,) = struct.unpack("<I", data[8:12])
    head = json.loads(data[12:12 + n])
    if head.get("format") != "spine-detector/1" or head.get("bytes") != len(data):
        sys.exit("not a complete spine-detector/1 file")
    if hashlib.sha256(data[head["body"]:]).hexdigest() != head["stamp"]:
        sys.exit("the file's content stamp does not match: damaged")
    return head


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    data = src.read_bytes()
    head = header(data)
    name = "spine-detector-%s.bin" % head["stamp"][:16]
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("spine-detector-*"):
        if old.name != name:
            old.unlink()
    shutil.copyfile(src, OUT / name)
    index = {"format": "spine-detector-index/1", "detector": head["detector"], "file": name, "bytes": len(data), "stamp": head["stamp"]}
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print("public/detector/%s (%d bytes, stamp %s) and public/detector/index.json" % (name, len(data), head["stamp"][:16]))


if __name__ == "__main__":
    main()
