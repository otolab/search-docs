#!/usr/bin/env python3
"""Exercise ten-minute LanceDB retention with a pinned vector-search reader.

All data is created under a fresh temporary directory. The reader is a separate
process and pins an old table version before the writer appends new versions.
The test waits longer than the production retention interval before explicitly
calling optimize with that same interval.
"""

from __future__ import annotations

import gc
import hashlib
import json
import multiprocessing
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/db-engine/src/python"))

import lancedb


DIMENSION = 256
QUERY_VECTOR = [0.1] * DIMENSION
POLL_SECONDS = 0.5
RETENTION = timedelta(minutes=10)
MINIMUM_AGE_SECONDS = 610


def make_section(number: int) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": f"ten-minute-{number}",
        "document_path": f"docs/ten-minute-{number}.md",
        "heading": f"Ten-minute retention row {number}",
        "depth": 1,
        "content": f"Disposable vector retention row {number}",
        "token_count": 6,
        "vector": [0.1 + (number % 7) * 0.001] * DIMENSION,
        "parent_id": None,
        "order": number,
        "is_dirty": False,
        "document_hash": f"hash-ten-minute-{number}",
        "created_at": now,
        "updated_at": now,
        "start_line": 1,
        "end_line": 1,
        "section_number": [number, 0, 0],
    }


def file_snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def file_delta(before: dict[str, str], after: dict[str, str]) -> dict[str, int]:
    old_paths = set(before)
    new_paths = set(after)
    common = old_paths & new_paths
    return {
        "files_before": len(old_paths),
        "files_after": len(new_paths),
        "added": len(new_paths - old_paths),
        "removed": len(old_paths - new_paths),
        "changed": sum(before[path] != after[path] for path in common),
    }


def version_list(table) -> list[dict[str, str | int | None]]:
    versions = []
    for item in table.list_versions():
        timestamp = item.get("timestamp")
        versions.append({
            "version": item.get("version"),
            "timestamp": timestamp.isoformat() if hasattr(timestamp, "isoformat") else str(timestamp),
        })
    return versions


def version_summary(table) -> dict[str, int | None]:
    versions = version_list(table)
    numbers = [item["version"] for item in versions if isinstance(item["version"], int)]
    return {
        "count": len(numbers),
        "first": numbers[0] if numbers else None,
        "last": numbers[-1] if numbers else None,
    }


def search_vector(table) -> list[str]:
    rows = table.search(QUERY_VECTOR).limit(1).to_list()
    return [str(row.get("id")) for row in rows]


def pinned_vector_reader(
    uri: str,
    version: int,
    stop_event,
    ready_queue,
    result_queue,
    query_intervals,
    query_count,
    shared_lock,
) -> None:
    db = None
    table = None
    errors: list[dict[str, str]] = []
    last_matches: list[str] = []
    try:
        db = lancedb.connect(uri, read_consistency_interval=timedelta(seconds=0))
        table = db.open_table("sections")
        table.checkout(version)
        last_matches = search_vector(table)
        ready_queue.put({
            "status": "ready",
            "pinned_version": version,
            "rows": table.count_rows(),
            "vector_search_matches": last_matches,
        })

        while not stop_event.is_set():
            started_ns = time.monotonic_ns()
            try:
                last_matches = search_vector(table)
            except Exception as error:
                ended_ns = time.monotonic_ns()
                errors.append({
                    "stage": "vector_search_poll",
                    "type": type(error).__name__,
                    "message": str(error),
                })
                with shared_lock:
                    slot = query_count.value
                    if slot < len(query_intervals) // 2:
                        query_intervals[slot * 2] = started_ns
                        query_intervals[slot * 2 + 1] = ended_ns
                        query_count.value = slot + 1
                break
            ended_ns = time.monotonic_ns()
            with shared_lock:
                slot = query_count.value
                if slot < len(query_intervals) // 2:
                    query_intervals[slot * 2] = started_ns
                    query_intervals[slot * 2 + 1] = ended_ns
                    query_count.value = slot + 1
            stop_event.wait(POLL_SECONDS)

        result_queue.put({
            "status": "observed",
            "pinned_version": version,
            "query_count": query_count.value,
            "last_vector_search_matches": last_matches,
            "errors": errors,
        })
    except Exception as error:
        ready_queue.put({
            "status": "error",
            "stage": "reader_setup",
            "type": type(error).__name__,
            "message": str(error),
        })
    finally:
        table = None
        db = None
        gc.collect()


def probe_current_version(uri: str, output_queue) -> None:
    try:
        db = lancedb.connect(uri, read_consistency_interval=timedelta(seconds=0))
        table = db.open_table("sections")
        output_queue.put({
            "status": "success",
            "version": table.version,
            "rows": table.count_rows(),
            "vector_search_matches": search_vector(table),
        })
    except Exception as error:
        output_queue.put({
            "status": "error",
            "type": type(error).__name__,
            "message": str(error),
        })


class ObservedOptimize:
    def __init__(self, target, root: Path, events: list[dict]):
        self.target = target
        self.root = root
        self.events = events

    def __call__(self, *args, **kwargs):
        before_files = file_snapshot(self.root)
        before_versions = version_summary(self.target.__self__) if hasattr(self.target, "__self__") else {}
        started_ns = time.monotonic_ns()
        error = None
        try:
            return self.target(*args, **kwargs)
        except Exception as caught:
            error = f"{type(caught).__name__}: {caught}"
            raise
        finally:
            ended_ns = time.monotonic_ns()
            after_files = file_snapshot(self.root)
            after_versions = version_summary(self.target.__self__) if hasattr(self.target, "__self__") else {}
            self.events.append({
                "started_ns": started_ns,
                "ended_ns": ended_ns,
                "cleanup_older_than": str(kwargs.get("cleanup_older_than")),
                "error": error,
                "versions_before": before_versions,
                "versions_after": after_versions,
                "file_delta": file_delta(before_files, after_files),
            })

    def __getattr__(self, name):
        return getattr(self.target, name)


class ObservedTable:
    def __init__(self, target, root: Path, events: list[dict]):
        self.target = target
        self.root = root
        self.events = events

    @property
    def optimize(self):
        return ObservedOptimize(self.target.optimize, self.root, self.events)

    def __getattr__(self, name):
        return getattr(self.target, name)


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="search-docs-10m-vector-retention-", dir="/private/tmp"))
    index_root = root / "index"
    index_root.mkdir()
    context = multiprocessing.get_context("spawn")
    stop_reader = context.Event()
    ready_queue = context.Queue()
    result_queue = context.Queue()
    query_intervals = context.Array("q", 4096)
    query_count = context.Value("i", 0)
    shared_lock = context.Lock()
    reader = None
    children = []
    worker = None
    cleanup_safe = True
    errors: list[str] = []
    optimize_events: list[dict] = []
    result: dict = {
        "fixture_root": str(root),
        "fixture": "fresh disposable LanceDB index under /private/tmp",
        "lancedb_version": getattr(lancedb, "__version__", "unknown"),
        "retention": str(RETENTION),
        "minimum_pinned_version_age_seconds": MINIMUM_AGE_SECONDS,
        "reader_operation": "table.search(query_vector).limit(1).to_list()",
    }

    try:
        from worker import SearchDocsWorker

        worker = SearchDocsWorker(db_path=str(index_root))
        worker.vector_dimension = DIMENSION
        worker.init_tables()
        worker.perf_logger.stop()
        worker.embedding_model = object()  # Fixture vectors avoid model/network calls.

        actual_table = worker._get_sections_table()
        actual_table.add([make_section(-1)])
        pinned_version = actual_table.version
        pinned_since_ns = time.monotonic_ns()
        pinned_since_utc = datetime.now(timezone.utc).isoformat()
        initial_versions = version_list(actual_table)

        reader = context.Process(
            target=pinned_vector_reader,
            args=(
                str(index_root),
                pinned_version,
                stop_reader,
                ready_queue,
                result_queue,
                query_intervals,
                query_count,
                shared_lock,
            ),
        )
        reader.start()
        children.append(reader)
        reader_ready = ready_queue.get(timeout=60)
        if reader_ready.get("status") != "ready":
            raise RuntimeError(f"pinned vector reader did not become ready: {reader_ready}")

        worker._sections_table = ObservedTable(actual_table, index_root, optimize_events)
        for number in range(1, 101):
            worker.add_sections({"sections": [make_section(number)]})
        if worker._add_count != 100:
            raise RuntimeError(f"expected 100 add_sections calls, got {worker._add_count}")
        periodic_events = [event for event in optimize_events if event["error"] is None]
        if len(periodic_events) != 5:
            raise RuntimeError(f"expected five successful ten-minute periodic optimize calls, got {len(periodic_events)}")

        wait_deadline = pinned_since_ns + MINIMUM_AGE_SECONDS * 1_000_000_000
        last_progress = 0
        while time.monotonic_ns() < wait_deadline:
            if reader.exitcode is not None:
                raise RuntimeError("pinned reader exited before the ten-minute cleanup")
            elapsed = (time.monotonic_ns() - pinned_since_ns) / 1_000_000_000
            if elapsed - last_progress >= 60:
                print(
                    f"waiting for pinned version age: {elapsed:.0f}/{MINIMUM_AGE_SECONDS}s "
                    f"(vector polls={query_count.value})",
                    file=sys.stderr,
                    flush=True,
                )
                last_progress = elapsed
            time.sleep(min(5, max(0.05, (wait_deadline - time.monotonic_ns()) / 1_000_000_000)))

        worker.add_sections({"sections": [make_section(101)]})
        pre_cleanup_table = actual_table
        pre_cleanup_versions = version_list(pre_cleanup_table)
        pre_cleanup_snapshot = file_snapshot(index_root)
        latest_version_before_cleanup = actual_table.version

        cleanup_started_ns = time.monotonic_ns()
        cleanup_started_utc = datetime.now(timezone.utc).isoformat()
        cleanup_error = None
        try:
            pre_cleanup_table.optimize(cleanup_older_than=RETENTION)
        except Exception as error:
            cleanup_error = f"{type(error).__name__}: {error}"
        cleanup_ended_ns = time.monotonic_ns()
        cleanup_ended_utc = datetime.now(timezone.utc).isoformat()
        post_cleanup_versions = version_list(pre_cleanup_table)
        post_cleanup_snapshot = file_snapshot(index_root)

        # Keep the pinned process alive after cleanup to observe its next vector query.
        if reader.is_alive():
            reader.join(timeout=30)
        if reader.is_alive():
            stop_reader.set()
            reader.join(timeout=30)
        if reader.is_alive():
            reader.terminate()
            reader.join(timeout=5)
        if reader.is_alive():
            cleanup_safe = False
            errors.append(f"pinned reader could not be reaped; retained fixture {root}")
            reader_result = {"status": "unknown", "reason": "reader process remains alive"}
        else:
            reader_result = result_queue.get(timeout=10)
            if reader.exitcode != 0:
                errors.append(f"pinned reader exited with code {reader.exitcode}")

        current_probe_queue = context.Queue()
        current_probe = context.Process(
            target=probe_current_version,
            args=(str(index_root), current_probe_queue),
        )
        current_probe.start()
        children.append(current_probe)
        try:
            current_reader_result = current_probe_queue.get(timeout=30)
        except Exception as error:
            current_reader_result = {
                "status": "error",
                "message": f"current vector reader produced no result: {type(error).__name__}: {error}",
            }
        current_probe.join(timeout=30)
        if current_probe.is_alive():
            current_probe.terminate()
            current_probe.join(timeout=5)
        if current_probe.is_alive():
            cleanup_safe = False
            errors.append(f"current reader could not be reaped; retained fixture {root}")
        elif current_probe.exitcode != 0:
            errors.append(f"current reader exited with code {current_probe.exitcode}")

        intervals = []
        with shared_lock:
            for slot in range(query_count.value):
                intervals.append([
                    query_intervals[slot * 2],
                    query_intervals[slot * 2 + 1],
                ])
        overlaps = sum(
            query_end >= cleanup_started_ns and query_start <= cleanup_ended_ns
            for query_start, query_end in intervals
        )
        pinned_version_present_after = any(
            item.get("version") == pinned_version for item in post_cleanup_versions
        )
        age_seconds = (time.monotonic_ns() - pinned_since_ns) / 1_000_000_000
        result.update({
            "status": "error" if errors else "completed",
            "pinned_reader_ready": reader_ready,
            "pinned_version": pinned_version,
            "pinned_version_started_utc": pinned_since_utc,
            "pinned_version_age_seconds_at_cleanup": round(age_seconds, 3),
            "versions_at_pin": initial_versions,
            "add_sections_calls": worker._add_count,
            "periodic_optimize_call_count": len(periodic_events),
            "periodic_optimize_events": periodic_events,
            "versions_before_cleanup": pre_cleanup_versions,
            "latest_version_before_cleanup": latest_version_before_cleanup,
            "cleanup": {
                "operation": "table.optimize(cleanup_older_than=timedelta(minutes=10))",
                "started_utc": cleanup_started_utc,
                "ended_utc": cleanup_ended_utc,
                "error": cleanup_error,
                "versions_after": post_cleanup_versions,
                "pinned_version_present_after": pinned_version_present_after,
                "file_delta": file_delta(pre_cleanup_snapshot, post_cleanup_snapshot),
                "reader_query_intervals_overlapping_call": overlaps,
                "overlap_measurement": "wall-clock Python vector-query intervals; does not expose native execution intervals",
            },
            "pinned_reader_after_cleanup": reader_result,
            "new_reader_after_cleanup": current_reader_result,
            "limitations": [
                "one local temporary database, one LanceDB version, and one writer",
                "vector search uses a fixed fixture query vector; no embedding model or full service/MCP reader",
                "the explicit cleanup call uses the production ten-minute retention value after an aged version; it is not a multi-process service shutdown/crash test",
                "wall-clock call intervals do not prove native LanceDB work overlapped",
                "no dual active writer, other filesystem/host, or OS/power failure is tested",
            ],
            "harness_errors": errors,
        })
        print(json.dumps(result, indent=2))
        return 1 if errors else 0
    except Exception as error:
        result.update({
            "status": "error",
            "fatal": f"{type(error).__name__}: {error}",
            "harness_errors": errors,
        })
        print(json.dumps(result, indent=2))
        return 1
    finally:
        stop_reader.set()
        for child in children:
            if child.is_alive():
                child.join(timeout=5)
            if child.is_alive():
                child.terminate()
                child.join(timeout=5)
            if child.is_alive():
                cleanup_safe = False
        worker = None
        gc.collect()
        if cleanup_safe:
            shutil.rmtree(root, ignore_errors=False)
        else:
            print(f"cleanup skipped because child termination was not confirmed: {root}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
