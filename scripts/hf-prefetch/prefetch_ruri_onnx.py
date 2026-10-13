#!/usr/bin/env python3
"""Download Ruri ONNX into the Hugging Face cache (no embedding server)."""

from __future__ import annotations

import os
import sys
import time

from huggingface_hub import snapshot_download

DEFAULT_REPO = "sirasagi62/ruri-v3-30m-ONNX"
MAX_ATTEMPTS = int(os.environ.get("HF_PREFETCH_MAX_ATTEMPTS", "5"))


def main() -> None:
    repo = os.environ.get("SEARCH_DOCS_ONNX_HF_REPO", DEFAULT_REPO)
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    last_error: BaseException | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            path = snapshot_download(repo)
            print(f"prefetch_ruri_onnx: cached {repo} at {path}")
            return
        except BaseException as exc:  # noqa: BLE001 — retry on any hub/network failure
            last_error = exc
            print(f"prefetch_ruri_onnx: attempt {attempt}/{MAX_ATTEMPTS} failed: {exc}", file=sys.stderr)
            if attempt < MAX_ATTEMPTS:
                time.sleep(attempt * 2)

    assert last_error is not None
    raise last_error


if __name__ == "__main__":
    main()
