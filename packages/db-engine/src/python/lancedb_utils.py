"""Shared LanceDB connection and read-recovery helpers."""

import re
import sys
from datetime import timedelta
from typing import Callable, Optional, TypeVar

import lancedb


READ_CONSISTENCY_INTERVAL = timedelta(seconds=5)

_LANCE_OBJECT_NOT_FOUND_RE = re.compile(
    r"^(?:lance error:\s*)?"
    r"(?:(?:LanceError\(IO\)|Generic N/A error|Cloned error):\s*)+"
    r"Object at location\s+(?P<path>.+?)\s+not found: "
    r"No such file or directory \(os error 2\)"
    r"(?:,\s*[^,\r\n]+\.rs:\d+:\d+)*$",
    re.IGNORECASE,
)
_LEGACY_LANCE_NOT_FOUND_RE = re.compile(
    r"^lance error:\s*Not found:\s*(?P<path>[^,\r\n]+),\s*"
    r".*[/\\]lance-io-\d+\.\d+\.\d+[/\\]src[/\\]local\.rs:\d+:\d+\s*$",
    re.IGNORECASE,
)
_LANCE_TABLE_FILE_RE = re.compile(
    r"^(?:/)?(?:[^/]+/)*[^/]+\.lance/"
    r"(?:data/[^/]+\.lance|_indices/[^/]+/"
    r"(?:page_data|page_lookup|bitmap|bitmap_page_lookup)\.lance)$",
    re.IGNORECASE,
)

T = TypeVar("T")


def connect_lancedb(uri: str):
    """Connect with the read freshness policy used by every application reader."""
    return lancedb.connect(uri, read_consistency_interval=READ_CONSISTENCY_INTERVAL)


def is_lance_not_found(error: Exception) -> bool:
    """Return whether a LanceDB data or scalar-index file is missing."""
    message = str(error).strip()
    current_match = _LANCE_OBJECT_NOT_FOUND_RE.fullmatch(message)
    legacy_match = _LEGACY_LANCE_NOT_FOUND_RE.fullmatch(message)
    match = current_match or legacy_match
    if match is None:
        return False

    # Restrict recovery to files LanceDB reads from table data/index storage.
    # In particular, a generic "Not found" or a missing manifest is not enough.
    path = match.group("path").strip().replace("\\", "/")
    return _LANCE_TABLE_FILE_RE.fullmatch(path) is not None


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
