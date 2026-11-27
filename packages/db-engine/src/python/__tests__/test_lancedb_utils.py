"""LanceDB connections use one freshness policy and retry missing files once."""

import sys
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schemas import SECTIONS_TABLE
from lancedb_utils import (
    READ_CONSISTENCY_INTERVAL,
    connect_lancedb,
    read_table_with_retry,
)
from worker import SearchDocsWorker


def test_connect_lancedb_sets_the_shared_read_consistency_interval(monkeypatch):
    connect = Mock(return_value=object())
    monkeypatch.setattr("lancedb_utils.lancedb.connect", connect)

    result = connect_lancedb("/tmp/index")

    assert result is connect.return_value
    connect.assert_called_once_with(
        "/tmp/index",
        read_consistency_interval=timedelta(seconds=5),
    )
    assert READ_CONSISTENCY_INTERVAL == timedelta(seconds=5)


class ReadTable:
    def __init__(self, results):
        self.results = list(results)
        self.calls = 0

    def read(self):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class ReadDatabase:
    def __init__(self, refreshed_table):
        self.refreshed_table = refreshed_table
        self.open_calls = []

    def open_table(self, table_name):
        self.open_calls.append(table_name)
        return self.refreshed_table


def test_read_table_reopens_once_and_retries_not_found(capsys):
    stale_table = ReadTable([RuntimeError("lance error: Not found: fragment.lance")])
    refreshed_table = ReadTable([["latest"]])
    db = ReadDatabase(refreshed_table)
    refreshed = []

    result = read_table_with_retry(
        db,
        "sections",
        lambda table: table.read(),
        table=stale_table,
        on_table_change=refreshed.append,
    )

    assert result == ["latest"]
    assert stale_table.calls == 1
    assert refreshed_table.calls == 1
    assert db.open_calls == ["sections"]
    assert refreshed == [refreshed_table]
    assert "retrying once" in capsys.readouterr().err


def test_read_table_does_not_retry_other_errors():
    stale_table = ReadTable([RuntimeError("permission denied")])
    db = ReadDatabase(ReadTable([["unused"]]))

    with pytest.raises(RuntimeError, match="permission denied"):
        read_table_with_retry(
            db,
            "sections",
            lambda table: table.read(),
            table=stale_table,
        )

    assert stale_table.calls == 1
    assert db.open_calls == []


def test_read_table_propagates_not_found_after_one_retry():
    stale_table = ReadTable([RuntimeError("Not found: stale fragment")])
    refreshed_table = ReadTable([RuntimeError("Not found: latest fragment")])
    db = ReadDatabase(refreshed_table)

    with pytest.raises(RuntimeError, match="latest fragment"):
        read_table_with_retry(
            db,
            "sections",
            lambda table: table.read(),
            table=stale_table,
        )

    assert stale_table.calls == 1
    assert refreshed_table.calls == 1
    assert db.open_calls == ["sections"]


def test_read_table_retries_when_open_table_reports_not_found():
    refreshed_table = ReadTable([["latest"]])

    class Database:
        def __init__(self):
            self.open_calls = 0

        def open_table(self, table_name):
            self.open_calls += 1
            if self.open_calls == 1:
                raise RuntimeError("Not found: stale manifest")
            return refreshed_table

    db = Database()
    changed_tables = []

    assert read_table_with_retry(
        db,
        "sections",
        lambda table: table.read(),
        on_table_change=changed_tables.append,
    ) == ["latest"]
    assert db.open_calls == 2
    assert changed_tables == [refreshed_table]


def test_worker_replaces_its_cached_table_after_reopening():
    stale_table = ReadTable([RuntimeError("Not found: stale fragment")])
    refreshed_table = ReadTable([["latest"]])
    db = ReadDatabase(refreshed_table)
    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker.db = db
    worker._sections_table = stale_table
    worker._index_requests_table = None

    assert worker._read_table(SECTIONS_TABLE, lambda table: table.read()) == ["latest"]
    assert worker._sections_table is refreshed_table


@pytest.mark.parametrize("read_only", [False, True])
def test_worker_uses_consistent_connection_for_both_modes(
    tmp_path, monkeypatch, read_only
):
    connection = Mock()
    connect = Mock(return_value=connection)
    performance_logger = Mock()
    monkeypatch.setattr("worker.connect_lancedb", connect)
    monkeypatch.setattr(
        "worker.PerformanceLogger",
        lambda interval: performance_logger,
    )

    worker = SearchDocsWorker(str(tmp_path), read_only=read_only)

    connect.assert_called_once_with(str(tmp_path))
    assert worker.db is connection
    performance_logger.start.assert_called_once()
