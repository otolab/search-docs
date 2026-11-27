"""Shared LanceDB connection and read-recovery helpers."""

import sys
from datetime import timedelta
from typing import Callable, Optional, TypeVar

import lancedb


READ_CONSISTENCY_INTERVAL = timedelta(seconds=5)

T = TypeVar("T")


def connect_lancedb(uri: str):
    """Connect with the read freshness policy used by every application reader."""
    return lancedb.connect(uri, read_consistency_interval=READ_CONSISTENCY_INTERVAL)


def is_lance_not_found(error: Exception) -> bool:
    """Return whether a LanceDB read failed because a referenced file is missing."""
    return "not found" in str(error).lower()


def read_table_with_retry(
    db,
    table_name: str,
    operation: Callable[[object], T],
    table=None,
    on_table_change: Optional[Callable[[object], None]] = None,
) -> T:
    """Retry a table read once after reopening its latest snapshot on Not found."""
    try:
        current_table = table if table is not None else db.open_table(table_name)
        if table is None and on_table_change is not None:
            on_table_change(current_table)
        return operation(current_table)
    except Exception as error:
        if not is_lance_not_found(error):
            raise

        sys.stderr.write(
            f"[LanceDB] Not found while reading {table_name}; "
            f"reopening the table and retrying once: {error}\n"
        )
        sys.stderr.flush()

    refreshed_table = db.open_table(table_name)
    if on_table_change is not None:
        on_table_change(refreshed_table)
    return operation(refreshed_table)
