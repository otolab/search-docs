#!/usr/bin/env python3
"""Exercise the real SearchDocsWorker periodic optimize/compaction on a disposable DB."""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import shutil
import sys
import tempfile
import time
from datetime import timedelta, timezone, datetime
from pathlib import Path

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/db-engine/src/python"))

import lancedb


def snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def snapshot_delta(before: dict[str, str], after: dict[str, str]) -> dict[str, int]:
    before_paths = set(before)
    after_paths = set(after)
    common = before_paths & after_paths
    return {
        "files_before": len(before_paths),
        "files_after": len(after_paths),
        "added": len(after_paths - before_paths),
        "removed": len(before_paths - after_paths),
        "changed": sum(before[path] != after[path] for path in common),
    }


def version_summary(table) -> dict[str, int | None]:
    numbers = [item["version"] for item in table.list_versions()]
    return {
        "count": len(numbers),
        "first": numbers[0] if numbers else None,
        "last": numbers[-1] if numbers else None,
    }


def hold_old_reader(
    uri: str,
    stop: multiprocessing.synchronize.Event,
    ready: multiprocessing.queues.Queue,
    result: multiprocessing.queues.Queue,
    observations,
    observation_count,
    observation_lock,
) -> None:
    try:
        db = lancedb.connect(uri, read_consistency_interval=timedelta(seconds=0))
        table = db.open_table("sections")
        pinned_version = table.version
        table.checkout(pinned_version)
        before_rows = table.count_rows()
        ready.put({"status": "ready", "version": pinned_version, "rows": before_rows})
        concurrent_errors: list[str] = []

        while not stop.is_set():
            try:
                rows = table.count_rows()
                table.search().limit(1).to_list()
                observed_at = time.monotonic_ns()
                with observation_lock:
                    index = observation_count.value
                    if index < len(observations):
                        observations[index] = observed_at
                        observation_count.value = index + 1
            except Exception as error:
                concurrent_errors.append(f"{type(error).__name__}: {error}")
                break
            time.sleep(0.002)

        try:
            post_rows = table.count_rows()
            table.search().limit(1).to_list()
            result.put({
                "status": "success",
                "pinned_version": pinned_version,
                "rows_before": before_rows,
                "rows_after_cleanup": post_rows,
                "poll_count": observation_count.value,
                "concurrent_errors": concurrent_errors,
                "versions_visible_from_old_handle": version_summary(table),
            })
        except Exception as error:
            result.put({
                "status": "error",
                "stage": "read_after_cleanup",
                "pinned_version": pinned_version,
                "error": f"{type(error).__name__}: {error}",
            })
    except Exception as error:
        ready.put({
            "status": "error",
            "stage": "open_old_reader",
            "error": f"{type(error).__name__}: {error}",
        })


def probe_new_reader(uri: str, output: multiprocessing.queues.Queue) -> None:
    try:
        db = lancedb.connect(uri, read_consistency_interval=timedelta(seconds=0))
        table = db.open_table("sections")
        rows = table.count_rows()
        table.search().limit(1).to_list()
        output.put({
            "status": "success",
            "version": table.version,
            "rows": rows,
            "versions": version_summary(table),
        })
    except Exception as error:
        output.put({
            "status": "error",
            "error": f"{type(error).__name__}: {error}",
        })


def query_new_reader(context, uri: str, unreaped_children: list) -> dict:
    output = context.Queue()
    process = context.Process(target=probe_new_reader, args=(uri, output))
    process.start()
    try:
        try:
            result = output.get(timeout=30)
        except Exception as error:
            process.join(timeout=5)
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
                if process.is_alive():
                    unreaped_children.append(process)
            return {
                "status": "error",
                "error": f"new reader produced no result: {type(error).__name__}: {error}",
            }
        process.join(timeout=30)
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
            if process.is_alive():
                unreaped_children.append(process)
            return {"status": "error", "error": "new reader did not exit"}
        if process.exitcode != 0:
            return {
                "status": "error",
                "error": f"new reader exit code {process.exitcode}",
                "result": result,
            }
        return result
    finally:
        output.close()


class ObservedOptimize:
    def __init__(self, target, root: Path, events: list[dict], operation: str):
        self.target = target
        self.root = root
        self.events = events
        self.operation = operation

    def __call__(self, *args, **kwargs):
        before = snapshot(self.root)
        started = time.monotonic_ns()
        try:
            return self.target(*args, **kwargs)
        finally:
            ended = time.monotonic_ns()
            after = snapshot(self.root)
            self.events.append({
                "operation": self.operation,
                "started_ns": started,
                "ended_ns": ended,
                "file_delta": snapshot_delta(before, after),
            })

    def __getattr__(self, name):
        if name == "compact_files":
            before = snapshot(self.root)
            started = time.monotonic_ns()
            try:
                return getattr(self.target, name)
            except AttributeError as error:
                ended = time.monotonic_ns()
                after = snapshot(self.root)
                self.events.append({
                    "operation": "product_periodic_compact_files_attempt",
                    "started_ns": started,
                    "ended_ns": ended,
                    "status": "failed_before_lancedb_api",
                    "error": str(error),
                    "file_delta": snapshot_delta(before, after),
                })
                raise
        return getattr(self.target, name)


class ObservedTable:
    def __init__(self, target, root: Path, events: list[dict]):
        self.target = target
        self.root = root
        self.events = events

    @property
    def optimize(self):
        return ObservedOptimize(self.target.optimize, self.root, self.events, "periodic_optimize")

    def __getattr__(self, name):
        return getattr(self.target, name)


def make_section(number: int) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": f"periodic-{number}",
        "document_path": f"docs/periodic-{number}.md",
        "heading": f"Periodic section {number}",
        "depth": 1,
        "content": f"Disposable periodic maintenance row {number}",
        "token_count": 6,
        "vector": [0.1] * 256,
        "parent_id": None,
        "order": number,
        "is_dirty": False,
        "document_hash": f"hash-{number}",
        "created_at": now,
        "updated_at": now,
        "start_line": 1,
        "end_line": 1,
        "section_number": [number, 0, 0],
    }


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="search-docs-periodic-reader-"))
    index_root = root / "index"
    index_root.mkdir()
    context = multiprocessing.get_context("spawn")
    old_reader = None
    stop_reader = context.Event()
    ready = context.Queue()
    old_result = context.Queue()
    observations = context.Array("q", 100_000)
    observation_count = context.Value("i", 0)
    observation_lock = context.Lock()
    cleanup_safe = True
    unreaped_children = []
    errors: list[str] = []
    worker = None
    optimize_events: list[dict] = []
    new_reader_probes: list[dict] = []
    milestones: list[dict] = []

    try:
        from worker import SearchDocsWorker

        worker = SearchDocsWorker(db_path=str(index_root))
        worker.vector_dimension = 256
        worker.init_tables()
        worker.perf_logger.stop()
        worker.embedding_model = object()  # Supplied vectors avoid model/network calls.

        sections = worker.db.open_table("sections")
        seed = make_section(-1)
        sections.add([seed])
        initial_version = sections.version
        initial_snapshot = snapshot(index_root)

        old_reader = context.Process(
            target=hold_old_reader,
            args=(
                str(index_root),
                stop_reader,
                ready,
                old_result,
                observations,
                observation_count,
                observation_lock,
            ),
        )
        old_reader.start()
        reader_ready = ready.get(timeout=30)
        if reader_ready.get("status") != "ready":
            raise RuntimeError(f"old reader failed to open: {reader_ready}")

        actual_table = worker._get_sections_table()
        worker._sections_table = ObservedTable(actual_table, index_root, optimize_events)
        original_maybe_optimize = worker._maybe_optimize

        def count_optimization_calls(table, table_name: str) -> None:
            next_count = worker._write_counts.get(table_name, 0) + 1
            interval = worker.OPTIMIZE_INTERVAL
            if table_name == "writer_heartbeat":
                interval = worker.HEARTBEAT_OPTIMIZE_INTERVAL
            before_events = len(optimize_events)
            original_maybe_optimize(table, table_name)
            if table_name == "sections" and next_count % interval == 0:
                if len(optimize_events) == before_events:
                    errors.append(f"periodic optimize #{next_count} was not observed")

        worker._maybe_optimize = count_optimization_calls

        for number in range(1, 101):
            worker.add_sections({"sections": [make_section(number)]})
            if number % 20 == 0:
                current_snapshot = snapshot(index_root)
                probe = query_new_reader(context, str(index_root), unreaped_children)
                new_reader_probes.append({"after_add_sections": number, **probe})
                if probe.get("status") != "success":
                    errors.append(f"new reader failed after {number} appends: {probe}")
                milestones.append({
                    "after_add_sections": number,
                    "snapshot": snapshot_delta(initial_snapshot, current_snapshot),
                    "new_reader": probe,
                })
                initial_snapshot = current_snapshot

        if worker._write_counts["sections"] != 100 or worker._add_count != 100:
            errors.append(
                "periodic counters did not reach 100 "
                f"(write_count={worker._write_counts['sections']}, add_count={worker._add_count})"
            )
        if sum(event["operation"] == "periodic_optimize" for event in optimize_events) != 5:
            errors.append("expected five real periodic optimize calls")
        product_compaction_attempts = [
            event for event in optimize_events
            if event["operation"] == "product_periodic_compact_files_attempt"
        ]
        if len(product_compaction_attempts) != 1:
            errors.append("expected one product compact_files attribute lookup at add_count 100")

        stop_reader.set()
        old_reader.join(timeout=30)
        if old_reader.is_alive():
            old_reader.terminate()
            old_reader.join(timeout=5)
        if old_reader.is_alive():
            cleanup_safe = False
            errors.append(f"old reader did not exit; retained fixture root {root}")
            old_reader_result = {"status": "unknown", "reason": "reader still alive"}
        else:
            old_reader_result = old_result.get(timeout=10)
            if old_reader.exitcode != 0:
                errors.append(f"old reader exited with code {old_reader.exitcode}")
        old_reader_during_writes = old_reader_result
        old_reader_during_writes_exitcode = old_reader.exitcode if old_reader else None

        # Branch the same completed writer state to compare cleanup with and without a reader.
        no_reader_root = root / "no-reader-cleanup"
        shutil.copytree(index_root, no_reader_root)

        # Reopen the pinned old-version reader for explicit maintenance on the original fixture.
        stop_reader.clear()
        ready = context.Queue()
        old_result = context.Queue()
        old_reader = context.Process(
            target=hold_old_reader,
            args=(
                str(index_root),
                stop_reader,
                ready,
                old_result,
                observations,
                observation_count,
                observation_lock,
            ),
        )
        old_reader.start()
        maintenance_reader_ready = ready.get(timeout=30)
        if maintenance_reader_ready.get("status") != "ready":
            raise RuntimeError(f"could not reopen old reader: {maintenance_reader_ready}")

        before_direct_compaction = snapshot(index_root)
        direct_compaction_started = time.monotonic_ns()
        direct_compaction_error = None
        try:
            sections.compact_files()
        except Exception as error:
            direct_compaction_error = f"{type(error).__name__}: {error}"
        direct_compaction_ended = time.monotonic_ns()
        after_direct_compaction = snapshot(index_root)
        optimize_events.append({
            "operation": "explicit_compact_files_control",
            "started_ns": direct_compaction_started,
            "ended_ns": direct_compaction_ended,
            "file_delta": snapshot_delta(before_direct_compaction, after_direct_compaction),
        })
        direct_compaction_probe = query_new_reader(context, str(index_root), unreaped_children)
        if direct_compaction_probe.get("status") != "success":
            errors.append(f"new reader failed after explicit compaction: {direct_compaction_probe}")

        before_active_cleanup = snapshot(index_root)
        versions_before_active_cleanup = version_summary(sections)
        active_cleanup_started = time.monotonic_ns()
        active_cleanup_error = None
        try:
            sections.optimize(cleanup_older_than=timedelta(seconds=0))
        except Exception as error:
            active_cleanup_error = f"{type(error).__name__}: {error}"
        active_cleanup_ended = time.monotonic_ns()
        after_active_cleanup = snapshot(index_root)
        optimize_events.append({
            "operation": "explicit_cleanup_with_old_reader",
            "started_ns": active_cleanup_started,
            "ended_ns": active_cleanup_ended,
            "error": active_cleanup_error,
            "file_delta": snapshot_delta(before_active_cleanup, after_active_cleanup),
        })
        versions_after_active_cleanup = version_summary(sections)
        active_cleanup_probe = query_new_reader(context, str(index_root), unreaped_children)
        if active_cleanup_probe.get("status") != "success":
            errors.append(f"new reader failed after cleanup with old reader: {active_cleanup_probe}")

        stop_reader.set()
        old_reader.join(timeout=30)
        if old_reader.is_alive():
            old_reader.terminate()
            old_reader.join(timeout=5)
        if old_reader.is_alive():
            cleanup_safe = False
            errors.append(f"old reader did not exit; retained fixture root {root}")
            old_reader_after_cleanup = {"status": "unknown", "reason": "reader still alive"}
        else:
            old_reader_after_cleanup = old_result.get(timeout=10)
            if old_reader.exitcode != 0:
                errors.append(f"old reader exited with code {old_reader.exitcode}")

        # Cleanup on the copied writer result without any open reader process.
        no_reader_db = lancedb.connect(
            str(no_reader_root),
            read_consistency_interval=timedelta(seconds=0),
        )
        no_reader_table = no_reader_db.open_table("sections")
        before_no_reader_cleanup = snapshot(no_reader_root)
        versions_before_no_reader_cleanup = version_summary(no_reader_table)
        no_reader_cleanup_error = None
        try:
            no_reader_table.optimize(cleanup_older_than=timedelta(seconds=0))
        except Exception as error:
            no_reader_cleanup_error = f"{type(error).__name__}: {error}"
        after_no_reader_cleanup = snapshot(no_reader_root)
        versions_after_no_reader_cleanup = version_summary(no_reader_table)
        no_reader_cleanup_probe = query_new_reader(context, str(no_reader_root), unreaped_children)
        if no_reader_cleanup_probe.get("status") != "success":
            errors.append(f"new reader failed after cleanup without reader: {no_reader_cleanup_probe}")

        event_summaries = []
        observed_at = list(observations[: observation_count.value])
        for event in optimize_events:
            overlaps = sum(
                event["started_ns"] <= timestamp <= event["ended_ns"]
                for timestamp in observed_at
            )
            event_summaries.append({
                "operation": event["operation"],
                "status": event.get("status", "success"),
                "error": event.get("error"),
                "duration_ms": round(
                    (event["ended_ns"] - event["started_ns"]) / 1_000_000,
                    3,
                ),
                "successful_old_reader_queries_during_call": overlaps,
                "file_delta": event["file_delta"],
            })

        result = {
            "status": "error" if errors else "success",
            "lancedb_version": getattr(lancedb, "__version__", "unknown"),
            "fixture": "new temporary directory; no existing project/index was opened",
            "writer": {
                "class": "SearchDocsWorker",
                "method": "add_sections",
                "calls": worker._add_count,
                "rows_appended": 100,
                "starting_version": initial_version,
                "periodic_optimize_interval": worker.OPTIMIZE_INTERVAL,
                "periodic_optimize_calls": sum(
                    event["operation"] == "periodic_optimize" for event in optimize_events
                ),
                "periodic_compact_files_attempt": product_compaction_attempts[0],
                "periodic_compact_files_api_invoked": False,
            },
            "old_reader": {
                "process_exit_code": old_reader_during_writes_exitcode,
                "observations": observation_count.value,
                "during_periodic_writes": old_reader_during_writes,
                "after_explicit_maintenance": old_reader_after_cleanup,
            },
            "new_reader_probes": new_reader_probes,
            "periodic_operation_observations": event_summaries,
            "explicit_maintenance_probes": {
                "direct_compact_files": {
                    "operation": "sections.compact_files()",
                    "deprecated_api": True,
                    "started_ns": direct_compaction_started,
                    "ended_ns": direct_compaction_ended,
                    "error": direct_compaction_error,
                    "file_delta": snapshot_delta(before_direct_compaction, after_direct_compaction),
                    "new_reader_after": direct_compaction_probe,
                },
                "cleanup_with_old_reader_open": {
                    "operation": "sections.optimize(cleanup_older_than=0)",
                    "started_ns": active_cleanup_started,
                    "ended_ns": active_cleanup_ended,
                    "error": active_cleanup_error,
                    "versions_before": versions_before_active_cleanup,
                    "versions_after": versions_after_active_cleanup,
                    "file_delta": snapshot_delta(before_active_cleanup, after_active_cleanup),
                    "new_reader_after": active_cleanup_probe,
                    "old_reader_after": old_reader_after_cleanup,
                },
                "cleanup_without_reader": {
                    "operation": "sections.optimize(cleanup_older_than=0) on quiescent file copy",
                    "error": no_reader_cleanup_error,
                    "versions_before": versions_before_no_reader_cleanup,
                    "versions_after": versions_after_no_reader_cleanup,
                    "file_delta": snapshot_delta(before_no_reader_cleanup, after_no_reader_cleanup),
                    "new_reader_after": no_reader_cleanup_probe,
                },
            },
            "milestones": milestones,
            "limitations": [
                "single local disposable DB and one pinned LanceDB version",
                "one writer only; no dual-active-writer condition",
                "reader polling overlapped only where timestamps fall inside the measured API call; this is not a native API failpoint",
                "zero-age cleanup is a test-only explicit call; product periodic optimize uses a ten-minute age threshold",
                "does not establish safety on other filesystems, hosts, or after OS/power failure",
            ],
            "errors": errors,
        }
        print(json.dumps(result, indent=2))
        return 1 if errors else 0
    finally:
        stop_reader.set()
        if old_reader is not None and old_reader.is_alive():
            old_reader.terminate()
            old_reader.join(timeout=5)
        if old_reader is not None and old_reader.is_alive():
            cleanup_safe = False
        if any(process.is_alive() for process in unreaped_children):
            cleanup_safe = False
        if worker is not None:
            worker.perf_logger.stop()
        if cleanup_safe:
            shutil.rmtree(root)
        else:
            print(f"cleanup skipped; fixture root retained for inspection: {root}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
