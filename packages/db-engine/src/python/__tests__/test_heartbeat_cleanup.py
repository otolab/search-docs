"""writer_heartbeat の MVCC 世代整理テスト"""

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, call

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from schemas import get_writer_heartbeat_schema, WRITER_HEARTBEAT_TABLE
from worker import SearchDocsWorker


def make_worker(db=None):
    """__init__ の副作用を避けたテスト用 Worker を作成する"""
    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker._write_counts = {
        "sections": 0,
        "index_requests": 0,
        WRITER_HEARTBEAT_TABLE: 0,
    }
    if db is not None:
        worker.db = db
    return worker


def heartbeat_params(writer_id="writer-1"):
    return {
        "writer_id": writer_id,
        "host": "localhost",
        "pid": 1234,
        "state": "watching",
    }


def test_heartbeat_optimize_uses_dedicated_interval_and_safe_retention():
    worker = make_worker()
    table = Mock()

    for _ in range(worker.HEARTBEAT_OPTIMIZE_INTERVAL - 1):
        worker._maybe_optimize(table, WRITER_HEARTBEAT_TABLE)

    table.optimize.assert_not_called()

    worker._maybe_optimize(table, WRITER_HEARTBEAT_TABLE)

    table.optimize.assert_called_once_with(
        cleanup_older_than=timedelta(minutes=10)
    )
    assert worker._write_counts[WRITER_HEARTBEAT_TABLE] == worker.HEARTBEAT_OPTIMIZE_INTERVAL
    assert worker.CLEANUP_OLDER_THAN >= timedelta(minutes=10)


def test_heartbeat_writes_prune_old_versions_when_cleanup_runs(tmp_path):
    """実 DB で定期 optimize が heartbeat の古い世代を整理する"""
    import lancedb

    db = lancedb.connect(str(tmp_path))
    db.create_table(WRITER_HEARTBEAT_TABLE, schema=get_writer_heartbeat_schema())
    worker = make_worker(db)

    # 実時間で 10 分待たずに prune を検証するため、保持期間だけを短縮する。
    # 本番の SearchDocsWorker.CLEANUP_OLDER_THAN は上のテストで 10 分以上を確認する。
    worker.HEARTBEAT_OPTIMIZE_INTERVAL = 3
    worker.CLEANUP_OLDER_THAN = timedelta(seconds=0)

    for i in range(worker.HEARTBEAT_OPTIMIZE_INTERVAL):
        worker.update_heartbeat({
            "writer_id": f"writer-{i}",
            "host": "localhost",
            "pid": 1234,
            "state": "watching",
        })

    table = db.open_table(WRITER_HEARTBEAT_TABLE)
    assert table.count_rows() == 1
    assert len(table.list_versions()) == 1


@pytest.mark.parametrize("method_name", ["claim_writer", "update_heartbeat"])
def test_heartbeat_add_paths_trigger_cleanup_counter(method_name):
    table = Mock()
    db = Mock()
    db.open_table.return_value = table
    worker = make_worker(db)
    worker._maybe_optimize = Mock()

    if method_name == "claim_writer":
        result = worker.claim_writer(heartbeat_params())
    else:
        result = worker.update_heartbeat(heartbeat_params())

    assert result["success"] is True
    table.add.assert_called_once()
    assert table.add.call_args.kwargs["mode"] == "overwrite"
    worker._maybe_optimize.assert_called_once_with(table, WRITER_HEARTBEAT_TABLE)


@pytest.mark.parametrize("method_name", ["claim_writer", "update_heartbeat"])
def test_heartbeat_add_retries_retryable_commit_conflict(method_name, monkeypatch):
    table = Mock()
    table.add.side_effect = [
        RuntimeError("Retryable commit conflict: Please retry"),
        RuntimeError("Retryable commit conflict: Please retry"),
        None,
    ]
    db = Mock()
    db.open_table.return_value = table
    worker = make_worker(db)
    worker._maybe_optimize = Mock()
    sleep = Mock()
    monkeypatch.setattr("worker.time.sleep", sleep)

    if method_name == "claim_writer":
        result = worker.claim_writer(heartbeat_params())
    else:
        result = worker.update_heartbeat(heartbeat_params())

    assert result["success"] is True
    assert table.add.call_count == 3
    assert sleep.call_args_list == [call(0.05), call(0.1)]
    worker._maybe_optimize.assert_called_once_with(table, WRITER_HEARTBEAT_TABLE)


def test_heartbeat_add_does_not_retry_non_retryable_error(monkeypatch):
    table = Mock()
    table.add.side_effect = RuntimeError("permission denied")
    db = Mock()
    db.open_table.return_value = table
    worker = make_worker(db)
    sleep = Mock()
    monkeypatch.setattr("worker.time.sleep", sleep)

    with pytest.raises(RuntimeError, match="permission denied"):
        worker.update_heartbeat(heartbeat_params())

    table.add.assert_called_once()
    sleep.assert_not_called()


def test_heartbeat_add_raises_after_retry_exhaustion(monkeypatch):
    table = Mock()
    table.add.side_effect = RuntimeError("Retryable commit conflict: Please retry")
    db = Mock()
    db.open_table.return_value = table
    worker = make_worker(db)
    sleep = Mock()
    monkeypatch.setattr("worker.time.sleep", sleep)

    with pytest.raises(RuntimeError, match="Retryable commit conflict"):
        worker.update_heartbeat(heartbeat_params())

    assert table.add.call_count == worker.HEARTBEAT_MAX_RETRIES + 1
    assert sleep.call_count == worker.HEARTBEAT_MAX_RETRIES


class ConcurrentConflictTable:
    """2つの初回 overwrite のうち1つをLanceDB競合として再現するテーブル"""

    def __init__(self):
        self._lock = threading.Lock()
        self._first_writes = threading.Barrier(2)
        self._attempts = 0

    @property
    def attempts(self):
        with self._lock:
            return self._attempts

    def add(self, rows, mode):
        assert mode == "overwrite"
        with self._lock:
            self._attempts += 1
            attempt = self._attempts

        if attempt <= 2:
            self._first_writes.wait(timeout=5)
            if attempt == 1:
                raise RuntimeError("Retryable commit conflict: Please retry")


def test_concurrent_heartbeat_writes_retry_commit_conflict(monkeypatch):
    table = ConcurrentConflictTable()
    db = Mock()
    db.open_table.return_value = table
    workers = [make_worker(db), make_worker(db)]
    monkeypatch.setattr("worker.time.sleep", lambda _delay: None)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(worker.update_heartbeat, heartbeat_params(f"writer-{i}"))
            for i, worker in enumerate(workers)
        ]
        results = [future.result() for future in futures]

    assert all(result["success"] is True for result in results)
    assert table.attempts == 3


def test_release_path_triggers_cleanup_counter_after_delete():
    table = Mock()
    table.search.return_value.limit.return_value.to_list.return_value = []
    db = Mock()
    db.open_table.return_value = table
    worker = make_worker(db)
    worker._maybe_optimize = Mock()

    result = worker.release_writer({"writer_id": "writer-1"})

    assert result == {"success": True}
    table.delete.assert_called_once_with("writer_id IS NOT NULL")
    worker._maybe_optimize.assert_called_once_with(table, WRITER_HEARTBEAT_TABLE)
