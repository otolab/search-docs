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
    is_lance_not_found,
    read_table_with_retry,
)
from worker import SearchDocsWorker


CURRENT_MISSING_FRAGMENT = (
    "lance error: LanceError(IO): Object at location "
    "/tmp/index/sections.lance/data/fragment.lance not found: "
    "No such file or directory (os error 2)"
)
CURRENT_NESTED_MISSING_FRAGMENT = (
    "lance error: LanceError(IO): Generic N/A error: Cloned error: "
    "Cloned error: LanceError(IO): Object at location "
    "/tmp/index/sections.lance/data/fragment.lance not found: "
    "No such file or directory (os error 2), "
    "/.../lance-io-4.0.0/src/object_reader.rs:270:51, "
    "/rustc/library/core/src/result.rs:1884:29"
)
LEGACY_MISSING_FRAGMENT = (
    "lance error: Not found: "
    "/Users/search/.search-docs/index/sections.lance/data/"
    "0b7f23a4-4c2d-4f18-98dd-b5c70bd65d27.lance, "
    "/.../lance-io-4.0.0/src/local.rs:132:40"
)
LEGACY_MISSING_SCALAR_INDEX = (
    "lance error: Not found: "
    "/Users/search/.search-docs/index/sections.lance/_indices/"
    "6f15d8ca-03bb-4b5f-a791-12f5541b67c8/page_data.lance, "
    "/.../lance-io-4.0.0/src/local.rs:132:40"
)


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


def test_is_lance_not_found_matches_current_and_legacy_table_files():
    assert is_lance_not_found(RuntimeError(CURRENT_MISSING_FRAGMENT))
    assert is_lance_not_found(RuntimeError(CURRENT_NESTED_MISSING_FRAGMENT))
    assert is_lance_not_found(RuntimeError(LEGACY_MISSING_FRAGMENT))
    assert is_lance_not_found(RuntimeError(LEGACY_MISSING_SCALAR_INDEX))


@pytest.mark.parametrize(
    "message",
    [
        "column not found: document_path",
        "index not found: status_idx",
        "Not found: stale manifest",
        (
            "lance error: Not found: /tmp/project/config.json, "
            "/.../lance-io-4.0.0/src/local.rs:132:40"
        ),
        (
            "lance error: LanceError(IO): Object at location "
            "/tmp/project/config.json not found: "
            "No such file or directory (os error 2)"
        ),
        (
            "lance error: LanceError(IO): Object at location "
            "/tmp/index/sections.lance/data/fragment.txt not found: "
            "No such file or directory (os error 2)"
        ),
        (
            "lance error: Not found: "
            "/tmp/index/sections.lance/_versions/42.manifest, "
            "/.../lance-io-4.0.0/src/local.rs:132:40"
        ),
        (
            "lance error: Not found: "
            "/tmp/index/sections.lance/data/fragment.lance, "
            "unexpected source location"
        ),
        (
            "lance error: LanceError(IO): Object at location "
            "/tmp/index/sections.lance/_versions/42.manifest not found: "
            "No such file or directory (os error 2)"
        ),
    ],
)
def test_is_lance_not_found_rejects_unrelated_errors(message):
    assert not is_lance_not_found(RuntimeError(message))


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


@pytest.mark.parametrize(
    "message",
    [
        CURRENT_MISSING_FRAGMENT,
        CURRENT_NESTED_MISSING_FRAGMENT,
        LEGACY_MISSING_FRAGMENT,
    ],
    ids=[
        "current-lancedb-error",
        "current-wrapped-lancedb-error",
        "legacy-production-error",
    ],
)
def test_read_table_reopens_once_and_retries_not_found(message, capsys):
    stale_table = ReadTable([RuntimeError(message)])
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


@pytest.mark.parametrize(
    "message",
    [
        "permission denied",
        "column not found: document_path",
        "index not found: status_idx",
        (
            "lance error: Not found: /tmp/project/config.json, "
            "/.../lance-io-4.0.0/src/local.rs:132:40"
        ),
        (
            "lance error: Not found: "
            "/tmp/index/sections.lance/_versions/42.manifest, "
            "/.../lance-io-4.0.0/src/local.rs:132:40"
        ),
        (
            "lance error: LanceError(IO): Object at location "
            "/tmp/project/config.json not found: "
            "No such file or directory (os error 2)"
        ),
    ],
)
def test_read_table_does_not_retry_other_errors(message):
    stale_table = ReadTable([RuntimeError(message)])
    db = ReadDatabase(ReadTable([["unused"]]))

    with pytest.raises(RuntimeError):
        read_table_with_retry(
            db,
            "sections",
            lambda table: table.read(),
            table=stale_table,
        )

    assert stale_table.calls == 1
    assert db.open_calls == []


def test_read_table_propagates_not_found_after_one_retry():
    stale_table = ReadTable(
        [
            RuntimeError(
                "LanceError(IO): Object at location "
                "/tmp/index/sections.lance/data/stale.lance not found: "
                "No such file or directory (os error 2)"
            )
        ]
    )
    refreshed_table = ReadTable(
        [
            RuntimeError(
                "LanceError(IO): Object at location "
                "/tmp/index/sections.lance/data/latest.lance not found: "
                "No such file or directory (os error 2)"
            )
        ]
    )
    db = ReadDatabase(refreshed_table)

    with pytest.raises(RuntimeError, match="latest\\.lance"):
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
                raise RuntimeError(
                    "LanceError(IO): Object at location "
                    "/tmp/index/sections.lance/data/stale.lance "
                    "not found: No such file or directory (os error 2)"
                )
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
    stale_table = ReadTable(
        [
            RuntimeError(
                "LanceError(IO): Object at location "
                "/tmp/index/sections.lance/data/stale.lance not found: "
                "No such file or directory (os error 2)"
            )
        ]
    )
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
