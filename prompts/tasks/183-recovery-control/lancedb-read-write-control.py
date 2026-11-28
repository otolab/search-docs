#!/usr/bin/env python3
"""Disposable control: table reads while ordinary LanceDB appends commit."""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import shutil
import tempfile
import threading
from datetime import timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import lancedb


def snapshot(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for file in sorted(path for path in root.rglob("*") if path.is_file()):
        result[str(file.relative_to(root))] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def read_pinned_version(
    uri: str,
    version: int,
    ready: multiprocessing.Queue,
    continue_read: multiprocessing.Event,
    result: multiprocessing.Queue,
) -> None:
    try:
        db = lancedb.connect(uri, read_consistency_interval=timedelta(seconds=0))
        table = db.open_table("rows")
        table.checkout(version)
        ready.put({"status": "ready", "rows": table.count_rows()})
    except Exception as error:
        ready.put({"status": "error", "stage": "open", "error": f"{type(error).__name__}: {error}"})
        return

    if not continue_read.wait(timeout=30):
        result.put({"status": "error", "stage": "wait", "error": "writer did not signal cleanup completion"})
        return
    try:
        result.put({"status": "success", "rows": table.count_rows()})
    except Exception as error:
        result.put({"status": "error", "stage": "read_after_cleanup", "error": f"{type(error).__name__}: {error}"})


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="search-docs-lancedb-read-write-"))
    reader_process: multiprocessing.Process | None = None
    cleanup_safe = True
    try:
        index_root = root / "index"
        index_root.mkdir()
        writer_db = lancedb.connect(str(index_root))
        writer_table = writer_db.create_table(
            "rows",
            data=[{"id": 0, "payload": "seed"}],
        )
        files_after_create = snapshot(index_root)

        reader_db = lancedb.connect(
            str(index_root),
            read_consistency_interval=timedelta(seconds=0),
        )
        reader_table = reader_db.open_table("rows")
        start = threading.Barrier(2)
        writer_done = threading.Event()
        errors: list[str] = []
        counts: list[int] = []
        writes = 40
        rows_per_write = 25

        def append_batches() -> None:
            try:
                start.wait()
                for batch in range(writes):
                    first_id = batch * rows_per_write + 1
                    writer_table.add([
                        {"id": row_id, "payload": f"row-{row_id}"}
                        for row_id in range(first_id, first_id + rows_per_write)
                    ])
            except Exception as error:  # surfaced after both threads finish
                errors.append(f"writer: {type(error).__name__}: {error}")
            finally:
                writer_done.set()

        def read_during_writes() -> None:
            try:
                start.wait()
                while not writer_done.is_set():
                    counts.append(reader_table.count_rows())
            except Exception as error:  # surfaced after both threads finish
                errors.append(f"reader: {type(error).__name__}: {error}")

        with ThreadPoolExecutor(max_workers=2) as executor:
            writer_future = executor.submit(append_batches)
            reader_future = executor.submit(read_during_writes)
            writer_future.result()
            reader_future.result()

        final_count = reader_table.count_rows()
        final_version = reader_table.version
        files_after_writes = snapshot(index_root)
        for _ in range(20):
            reader_table.count_rows()
            reader_table.search().limit(10).to_list()
        files_after_reads = snapshot(index_root)

        if errors:
            raise AssertionError("; ".join(errors))
        if not counts:
            raise AssertionError("reader did not overlap any writer batch")
        if any(after < before for before, after in zip(counts, counts[1:])):
            raise AssertionError(f"observed row count regressed: {counts}")
        expected_count = 1 + writes * rows_per_write
        if final_count != expected_count:
            raise AssertionError(f"expected {expected_count} rows, observed {final_count}")
        if files_after_reads != files_after_writes:
            raise AssertionError("read-only queries changed the disposable DB file snapshot")

        added_paths = set(files_after_writes) - set(files_after_create)
        added_by_directory: dict[str, int] = {}
        for relative in added_paths:
            parent = str(Path(relative).parent)
            added_by_directory[parent] = added_by_directory.get(parent, 0) + 1

        # A second disposable table probes one old reader across explicit version cleanup.
        cleanup_root = root / "cleanup-index"
        cleanup_root.mkdir()
        cleanup_writer_db = lancedb.connect(str(cleanup_root))
        cleanup_writer = cleanup_writer_db.create_table(
            "rows",
            data=[{"id": row_id} for row_id in range(100)],
        )
        old_version = cleanup_writer.version
        context = multiprocessing.get_context("spawn")
        ready: multiprocessing.Queue = context.Queue()
        result: multiprocessing.Queue = context.Queue()
        continue_read = context.Event()
        reader_process = context.Process(
            target=read_pinned_version,
            args=(str(cleanup_root), old_version, ready, continue_read, result),
        )
        reader_process.start()
        reader_ready = ready.get(timeout=30)
        if reader_ready.get("status") != "ready":
            raise AssertionError(f"could not establish old-version reader: {reader_ready}")

        cleanup_writer.add(
            [{"id": row_id} for row_id in range(1000, 1100)],
            mode="overwrite",
        )
        cleanup_writer.optimize(cleanup_older_than=timedelta(seconds=0))
        remaining_versions = [item["version"] for item in cleanup_writer.list_versions()]
        continue_read.set()
        old_reader_after_cleanup = result.get(timeout=30)
        reader_process.join(timeout=30)
        if reader_process.is_alive():
            reader_process.terminate()
            reader_process.join(timeout=5)
        if reader_process.is_alive():
            cleanup_safe = False
            raise RuntimeError(f"fixture reader did not stop; retained root: {root}")
        if reader_process.exitcode != 0:
            raise AssertionError(f"fixture reader exited with {reader_process.exitcode}")

        print(json.dumps({
            "lancedb_version": getattr(lancedb, "__version__", "unknown"),
            "read_consistency_interval_seconds": 0,
            "table_create_file_count": len(files_after_create),
            "ordinary_appends": writes,
            "rows_per_append": rows_per_write,
            "reader_observations_during_writes": len(counts),
            "observed_row_count_min_max": [min(counts), max(counts)],
            "final_row_count": final_count,
            "final_table_version": final_version,
            "new_file_count_from_appends": len(added_paths),
            "new_file_counts_by_directory": added_by_directory,
            "read_only_query_snapshot_unchanged": files_after_reads == files_after_writes,
            "cleanup_probe": {
                "mode": "second process holds version 1 while writer overwrites then optimize(cleanup_older_than=0)",
                "old_reader_rows_before_cleanup": reader_ready.get("rows"),
                "versions_remaining_after_cleanup": remaining_versions,
                "old_reader_after_cleanup": old_reader_after_cleanup,
                "scope": "one local disposable table; not a guarantee for other readers/filesystems",
            },
            "scope": "disposable local filesystem; single-process append/query and separate-process cleanup probe",
        }, indent=2))
    finally:
        if reader_process is not None and reader_process.is_alive():
            reader_process.terminate()
            reader_process.join(timeout=5)
        if reader_process is not None and reader_process.is_alive():
            cleanup_safe = False
        if cleanup_safe:
            shutil.rmtree(root)
        else:
            print(f"cleanup skipped; fixture root retained for inspection: {root}")

if __name__ == "__main__":
    main()
