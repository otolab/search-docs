"""writer_heartbeat の MVCC 世代整理テスト"""

import sys
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

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
