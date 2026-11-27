"""Real LanceDB regression for a reader pinned to files pruned by another process."""

import multiprocessing
import time
from datetime import timedelta
from pathlib import Path
import sys

import lancedb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lancedb_utils import READ_CONSISTENCY_INTERVAL, connect_lancedb
from schemas import SECTIONS_TABLE
from worker import SearchDocsWorker


TABLE_NAME = "sections"


def append_and_prune(db_path, result_queue):
    """Write and prune versions from a distinct OS process."""
    try:
        db = connect_lancedb(db_path)
        table = db.open_table(TABLE_NAME)
        table.add([{"id": 2, "content": "new fragment"}])
        table.optimize(cleanup_older_than=timedelta(0))
        result_queue.put(None)
    except Exception as error:
        result_queue.put(f"{type(error).__name__}: {error}")


def make_table(db_path):
    db = lancedb.connect(str(db_path))
    table = db.create_table(
        TABLE_NAME,
        data=[{"id": 1, "content": "initial fragment"}],
    )
    return db, table


def prune_in_another_process(db_path):
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    process = context.Process(
        target=append_and_prune,
        args=(str(db_path), result_queue),
    )
    process.start()
    process.join(timeout=30)
    if process.is_alive():
        process.terminate()
        process.join()
        pytest.fail("LanceDB writer process did not finish within 30 seconds")
    assert process.exitcode == 0
    error = result_queue.get(timeout=5)
    assert error is None, error


def read_rows(table):
    return table.search().select(["id"]).limit(None).to_list()


def test_unconfigured_reader_reproduces_not_found_after_external_cleanup(tmp_path):
    _, reader_table = make_table(tmp_path)
    assert [row["id"] for row in read_rows(reader_table)] == [1]

    prune_in_another_process(tmp_path)

    with pytest.raises(Exception, match="(?i)not found"):
        read_rows(reader_table)


def test_worker_reopens_real_stale_snapshot_after_external_cleanup(tmp_path):
    # Pin the reader snapshot to exercise recovery independently of periodic refresh.
    db = lancedb.connect(
        str(tmp_path),
        read_consistency_interval=timedelta(days=1),
    )
    db.create_table(
        TABLE_NAME,
        data=[{"id": 1, "content": "initial fragment"}],
    )
    reader_table = db.open_table(TABLE_NAME)
    assert [row["id"] for row in read_rows(reader_table)] == [1]

    prune_in_another_process(tmp_path)
    with pytest.raises(Exception, match="(?i)not found"):
        read_rows(reader_table)

    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker.db = db
    worker._sections_table = reader_table
    worker._index_requests_table = None
    rows = worker._read_table(SECTIONS_TABLE, read_rows)

    assert sorted(row["id"] for row in rows) == [1, 2]


def test_configured_reader_refreshes_snapshot_after_consistency_interval(tmp_path):
    db = connect_lancedb(str(tmp_path))
    db.create_table(
        TABLE_NAME,
        data=[{"id": 1, "content": "initial fragment"}],
    )
    reader_table = db.open_table(TABLE_NAME)
    assert [row["id"] for row in read_rows(reader_table)] == [1]

    time.sleep(READ_CONSISTENCY_INTERVAL.total_seconds() + 0.1)
    prune_in_another_process(tmp_path)

    class CountingDatabase:
        def __init__(self, inner):
            self.inner = inner
            self.open_calls = 0

        def open_table(self, table_name):
            self.open_calls += 1
            return self.inner.open_table(table_name)

    counting_db = CountingDatabase(db)
    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker.db = counting_db
    worker._sections_table = reader_table
    worker._index_requests_table = None

    rows = worker._read_table(SECTIONS_TABLE, read_rows)

    assert sorted(row["id"] for row in rows) == [1, 2]
    assert counting_db.open_calls == 0
