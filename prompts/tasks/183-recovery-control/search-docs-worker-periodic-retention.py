#!/usr/bin/env python3
"""Observe ten-minute periodic cleanup with the real SearchDocsWorker.search.

This is a disposable, single-host control experiment. It uses a fresh database,
fixture vectors, one SearchDocsWorker writer, and one read-only-mode worker
reader. No product source or lock behavior is modified.
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
from datetime import datetime, timezone
from pathlib import Path

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/db-engine/src/python"))

DIMENSION = 256
QUERY = "disposable retention fixture"
POLL_SECONDS = float(os.environ.get("ISSUE183_QUERY_POLL_SECONDS", "0.25"))
MINIMUM_SEED_VERSION_AGE_SECONDS = int(
    os.environ.get(
        "ISSUE183_MINIMUM_SEED_VERSION_AGE_SECONDS",
        os.environ.get("ISSUE183_MINIMUM_PIN_AGE_SECONDS", "610"),
    )
)
PIN_READER = os.environ.get("ISSUE183_PIN_READER", "1") != "0"
INTERVAL_CAPACITY = 20_000


def make_section(number: int) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": f"worker-retention-{number}",
        "document_path": f"docs/worker-retention-{number}.md",
        "heading": f"Worker retention row {number}",
        "depth": 1,
        "content": f"Disposable worker retention row {number}",
        "token_count": 6,
        "vector": [0.1 + (number % 7) * 0.001] * DIMENSION,
        "parent_id": None,
        "order": number,
        "is_dirty": False,
        "document_hash": f"hash-worker-retention-{number}",
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


class FixtureEmbedding:
    def encode(self, _text, _dimension):
        return [0.1] * DIMENSION


class ObservedTable:
    """Record optimize's public-call interval while delegating to LanceDB."""

    def __init__(self, target, root: Path, events: list[dict]):
        self.target = target
        self.root = root
        self.events = events

    def __getattr__(self, name):
        return getattr(self.target, name)

    def optimize(self, **kwargs):
        before_files = file_snapshot(self.root)
        started_ns = time.monotonic_ns()
        started_utc = datetime.now(timezone.utc).isoformat()
        error = None
        try:
            return self.target.optimize(**kwargs)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            ended_ns = time.monotonic_ns()
            ended_utc = datetime.now(timezone.utc).isoformat()
            after_files = file_snapshot(self.root)
            self.events.append({
                "started_ns": started_ns,
                "ended_ns": ended_ns,
                "started_utc": started_utc,
                "ended_utc": ended_utc,
                "cleanup_older_than": str(kwargs.get("cleanup_older_than")),
                "error": error,
                "file_delta": file_delta(before_files, after_files),
            })


def worker_reader(
    db_path: str,
    pinned_version: int | None,
    stop_event,
    ready_queue,
    result_queue,
    query_intervals,
    query_success_flags,
    query_count,
    success_count,
    failure_count,
    shared_lock,
) -> None:
    worker = None
    errors: list[str] = []
    last_total = 0
    try:
        from worker import SearchDocsWorker

        worker = SearchDocsWorker(db_path=db_path, read_only=True)
        worker.vector_dimension = DIMENSION
        worker.embedding_model = FixtureEmbedding()
        worker.perf_logger.stop()
        table = worker._get_sections_table()
        if pinned_version is not None:
            table.checkout(pinned_version)
        first = worker.search({"query": QUERY, "limit": 1})
        if not first["results"]:
            raise RuntimeError("initial SearchDocsWorker.search returned no result")
        ready_queue.put({
            "status": "ready",
            "read_only_mode": worker.read_only,
            "pinned_version": pinned_version,
            "initial_result_count": first["total"],
        })

        while not stop_event.is_set():
            started_ns = time.monotonic_ns()
            error = None
            try:
                worker.search({"query": QUERY, "limit": 1})
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                errors.append(error)
            ended_ns = time.monotonic_ns()
            with shared_lock:
                slot = query_count.value
                if slot < len(query_intervals) // 2:
                    query_intervals[slot * 2] = started_ns
                    query_intervals[slot * 2 + 1] = ended_ns
                    query_success_flags[slot] = 1 if error is None else 0
                    query_count.value = slot + 1
                    if error is None:
                        success_count.value += 1
                    else:
                        failure_count.value += 1
            last_total = slot + 1
            if error is not None:
                break
            stop_event.wait(POLL_SECONDS)

        result_queue.put({
            "status": "observed",
            "read_only_mode": worker.read_only,
            "pinned_version": pinned_version,
            "query_count": last_total,
            "successful_searches": success_count.value,
            "failed_searches": failure_count.value,
            "errors": errors,
        })
    except Exception as exc:
        ready_queue.put({
            "status": "error",
            "stage": "reader_setup",
            "type": type(exc).__name__,
            "message": str(exc),
        })
    finally:
        if worker is not None:
            worker.perf_logger.stop()
        worker = None
        gc.collect()


def run() -> int:
    import lancedb

    context = multiprocessing.get_context("spawn")
    root = Path(tempfile.mkdtemp(prefix="search-docs-worker-periodic-retention-"))
    index_root = root / "index"
    index_root.mkdir()
    stop_reader = context.Event()
    ready_queue = context.Queue()
    result_queue = context.Queue()
    query_intervals = context.Array("q", INTERVAL_CAPACITY * 2)
    query_success_flags = context.Array("b", INTERVAL_CAPACITY)
    query_count = context.Value("i", 0)
    success_count = context.Value("i", 0)
    failure_count = context.Value("i", 0)
    shared_lock = context.Lock()
    reader = None
    writer = None
    children = []
    cleanup_safe = True
    errors: list[str] = []
    events: list[dict] = []
    result = {
        "fixture_root": str(root),
        "fixture": "fresh disposable LanceDB index under the system temporary directory",
        "lancedb_version": getattr(lancedb, "__version__", "unknown"),
        "minimum_seed_version_age_before_periodic_optimize_seconds": MINIMUM_SEED_VERSION_AGE_SECONDS,
        "reader_operation": "SearchDocsWorker.search(query, limit=1)",
        "reader_mode": (
            "SearchDocsWorker(read_only=True); checkout(version) snapshot"
            if PIN_READER else
            "SearchDocsWorker(read_only=True); no checkout; default read_consistency_interval=5s"
        ),
        "reader_poll_seconds": POLL_SECONDS,
        "writer_operation": "SearchDocsWorker.add_sections; its unmodified 20-write _maybe_optimize path",
    }

    try:
        from worker import SearchDocsWorker

        writer = SearchDocsWorker(db_path=str(index_root))
        writer.vector_dimension = DIMENSION
        writer.embedding_model = FixtureEmbedding()
        writer.init_tables()
        writer.perf_logger.stop()

        writer.add_sections({"sections": [make_section(0)]})
        table = writer._get_sections_table()
        seed_version = table.version
        seed_version_created_ns = time.monotonic_ns()
        seed_version_created_utc = datetime.now(timezone.utc).isoformat()
        versions_at_seed = [item["version"] for item in table.list_versions()]
        optimize_events = events
        writer._sections_table = ObservedTable(table, index_root, optimize_events)
        reader_version = seed_version if PIN_READER else None

        reader = context.Process(
            target=worker_reader,
            args=(
                str(index_root),
                reader_version,
                stop_reader,
                ready_queue,
                result_queue,
                query_intervals,
                query_success_flags,
                query_count,
                success_count,
                failure_count,
                shared_lock,
            ),
        )
        reader.start()
        children.append(reader)
        reader_ready = ready_queue.get(timeout=60)
        if reader_ready.get("status") != "ready":
            raise RuntimeError(f"read-only SearchDocsWorker reader not ready: {reader_ready}")

        deadline = seed_version_created_ns + MINIMUM_SEED_VERSION_AGE_SECONDS * 1_000_000_000
        last_progress = 0
        while time.monotonic_ns() < deadline:
            if reader.exitcode is not None:
                raise RuntimeError("SearchDocsWorker reader exited before the aged periodic optimize")
            elapsed = (time.monotonic_ns() - seed_version_created_ns) / 1_000_000_000
            if elapsed - last_progress >= 60:
                print(
                    f"waiting for seed version age: {elapsed:.0f}/{MINIMUM_SEED_VERSION_AGE_SECONDS}s "
                    f"(successful searches={success_count.value})",
                    file=sys.stderr,
                    flush=True,
                )
                last_progress = elapsed
            time.sleep(min(5, max(0.05, (deadline - time.monotonic_ns()) / 1_000_000_000)))

        before_trigger_ns = time.monotonic_ns()
        before_trigger_age = (before_trigger_ns - seed_version_created_ns) / 1_000_000_000
        calls_to_boundary = 20 - (writer._write_counts.get("sections", 0) % 20)
        for number in range(1, calls_to_boundary + 1):
            writer.add_sections({"sections": [make_section(number)]})
        if len(events) != 1:
            raise RuntimeError(f"expected one periodic optimize at boundary, observed {len(events)}")
        optimize = events[0]
        if optimize["error"] is not None:
            errors.append(f"periodic optimize failed: {optimize['error']}")
        age_at_optimize_start = (
            optimize["started_ns"] - seed_version_created_ns
        ) / 1_000_000_000
        versions_after = [item["version"] for item in table.list_versions()]
        seed_version_present = seed_version in versions_after

        # Let the reader continue for a bounded post-cleanup observation window.
        post_cleanup_observation_started_ns = time.monotonic_ns()
        if reader.is_alive():
            reader.join(timeout=10)
        reader_alive_after_observation = reader.is_alive()
        post_cleanup_observation_ended_ns = time.monotonic_ns()
        if reader.is_alive():
            stop_reader.set()
            reader.join(timeout=15)
        if reader.is_alive():
            cleanup_safe = False
            errors.append("SearchDocsWorker process did not stop; fixture retained")
            reader_result = {"status": "unknown", "reason": "process remains alive"}
        else:
            reader_result = result_queue.get(timeout=10)
            if reader.exitcode != 0:
                errors.append(f"SearchDocsWorker reader exited with code {reader.exitcode}")

        latest_reader_queue = context.Queue()
        latest_reader_stop = context.Event()
        latest_reader_stop.set()
        latest_reader_intervals = context.Array("q", 4)
        latest_reader_success_flags = context.Array("b", 2)
        latest_reader_query_count = context.Value("i", 0)
        latest_reader_success_count = context.Value("i", 0)
        latest_reader_failure_count = context.Value("i", 0)
        latest_reader_lock = context.Lock()
        latest_reader = context.Process(
            target=worker_reader,
            args=(
                str(index_root),
                None,
                latest_reader_stop,
                ready_queue,
                latest_reader_queue,
                latest_reader_intervals,
                latest_reader_success_flags,
                latest_reader_query_count,
                latest_reader_success_count,
                latest_reader_failure_count,
                latest_reader_lock,
            ),
        )
        latest_reader.start()
        children.append(latest_reader)
        latest_ready = ready_queue.get(timeout=60)
        if latest_ready.get("status") != "ready":
            errors.append(f"latest read-only worker could not search: {latest_ready}")
            latest_reader_result = latest_ready
        else:
            latest_reader.join(timeout=10)
            if latest_reader.is_alive():
                latest_reader.terminate()
                latest_reader.join(timeout=5)
            latest_reader_result = latest_reader_queue.get(timeout=10)
            if latest_reader.is_alive():
                cleanup_safe = False
                errors.append("latest SearchDocsWorker process did not stop; fixture retained")

        intervals = []
        post_cleanup_query_successes = 0
        post_cleanup_query_failures = 0
        with shared_lock:
            for slot in range(query_count.value):
                query_started_ns = query_intervals[slot * 2]
                query_ended_ns = query_intervals[slot * 2 + 1]
                query_succeeded = bool(query_success_flags[slot])
                intervals.append([query_started_ns, query_ended_ns])
                if (
                    query_started_ns >= optimize["ended_ns"]
                    and query_ended_ns <= post_cleanup_observation_ended_ns
                ):
                    if query_succeeded:
                        post_cleanup_query_successes += 1
                    else:
                        post_cleanup_query_failures += 1
        overlaps = sum(
            query_end >= optimize["started_ns"] and query_start <= optimize["ended_ns"]
            for query_start, query_end in intervals
        )
        result.update({
            "status": "error" if errors else "completed",
            "seed_version": seed_version,
            "reader_checked_out_version": reader_version,
            "seed_version_created_utc": seed_version_created_utc,
            "versions_at_seed": versions_at_seed,
            "seed_version_age_seconds_before_trigger_writes": round(before_trigger_age, 3),
            "seed_version_age_seconds_at_periodic_optimize_start": round(age_at_optimize_start, 3),
            "write_count_before_trigger": writer._write_counts.get("sections", 0) - calls_to_boundary,
            "write_count_after_trigger": writer._write_counts.get("sections", 0),
            "add_sections_calls": writer._add_count,
            "periodic_optimize_call_count": len(events),
            "post_cleanup_reader_observation_seconds": round(
                (post_cleanup_observation_ended_ns - optimize["ended_ns"]) / 1_000_000_000,
                3,
            ),
            "reader_alive_after_post_cleanup_observation": reader_alive_after_observation,
            "post_cleanup_query_count": (
                post_cleanup_query_successes + post_cleanup_query_failures
            ),
            "post_cleanup_successful_searches": post_cleanup_query_successes,
            "post_cleanup_failed_searches": post_cleanup_query_failures,
            "periodic_optimize": {
                "started_utc": optimize["started_utc"],
                "ended_utc": optimize["ended_utc"],
                "cleanup_older_than": optimize["cleanup_older_than"],
                "error": optimize["error"],
                "file_delta_during_call": optimize["file_delta"],
                "versions_after": versions_after,
                "seed_version_present_after": seed_version_present,
                "reader_search_calls_overlapping_optimize_wall_clock_interval": overlaps,
                "overlap_measurement": "whole Python SearchDocsWorker.search and optimize call intervals, not native LanceDB execution",
            },
            "reader_after_optimize": reader_result,
            "new_read_only_worker_ready_after_optimize": latest_ready,
            "new_read_only_worker_after_optimize": latest_reader_result,
            "query_count": query_count.value,
            "successful_searches": success_count.value,
            "failed_searches": failure_count.value,
            "limitations": [
                "one disposable database, one local host, one writer and one reader",
                "SearchDocsWorker(read_only=True) path is exercised directly; no TypeScript DBEngine, MCP/HTTP transport, or external embedding model",
                "fixture vectors and a fixed fixture query are used",
                "the reader behavior is indicated by reader_mode; it does not establish every service reader's snapshot behavior",
                "wall-clock Python-call overlap does not prove native LanceDB operations overlapped",
                "no competing writer, alternate filesystem/host, native API failpoint, OS crash, or power loss",
            ],
            "harness_errors": errors,
        })
        print(json.dumps(result, indent=2))
        return 1 if errors else 0
    except Exception as exc:
        result.update({
            "status": "error",
            "fatal": f"{type(exc).__name__}: {exc}",
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
        if writer is not None:
            writer.perf_logger.stop()
        writer = None
        gc.collect()
        if cleanup_safe:
            shutil.rmtree(root)
        else:
            print(f"cleanup skipped because child termination was not confirmed: {root}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(run())
