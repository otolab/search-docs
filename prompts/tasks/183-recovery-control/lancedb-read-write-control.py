#!/usr/bin/env python3
"""Disposable control: table reads while ordinary LanceDB appends commit."""

from __future__ import annotations

import hashlib
import json
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


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="search-docs-lancedb-read-write-") as temp:
        root = Path(temp) / "index"
        root.mkdir()
        writer_db = lancedb.connect(str(root))
        writer_table = writer_db.create_table(
            "rows",
            data=[{"id": 0, "payload": "seed"}],
        )
        files_after_create = snapshot(root)

        reader_db = lancedb.connect(
            str(root),
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
        files_after_writes = snapshot(root)
        for _ in range(20):
            reader_table.count_rows()
            reader_table.search().limit(10).to_list()
        files_after_reads = snapshot(root)

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
            "scope": "single process, two independent local LanceDB connections, disposable local filesystem",
        }, indent=2))


if __name__ == "__main__":
    main()
