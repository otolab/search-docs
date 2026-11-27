#!/usr/bin/env python3
"""Isolated scalar-index failure/retry experiment against the current worker code."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PYTHON_SOURCE = REPO / "packages/db-engine/src/python"
sys.path.insert(0, str(PYTHON_SOURCE))

from schemas import (  # noqa: E402
    get_index_requests_schema,
    get_sections_schema,
    get_writer_heartbeat_schema,
)
from worker import SearchDocsWorker  # noqa: E402


DIMENSION = 256
ROW_COUNT = 5_000
FAULT_TABLE = "index_requests"
FAULT_COLUMN = "status"


def canonical_hash(rows):
    content = json.dumps(rows, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(content.encode()).hexdigest()


def indices(table):
    return sorted(tuple(index.columns) for index in table.list_indices())


def section_rows():
    zero_vector = [0.0] * DIMENSION
    return [
        {
            "id": f"section-{number}",
            "document_path": f"docs/{number % 100:03d}.md",
            "heading": f"Heading {number}",
            "depth": number % 4,
            "content": f"Content {number}",
            "token_count": 3,
            "vector": zero_vector,
            "parent_id": None,
            "order": number,
            "is_dirty": number % 2 == 0,
            "document_hash": f"hash-{number % 250:03d}",
            "created_at": None,
            "updated_at": None,
            "start_line": number + 1,
            "end_line": number + 1,
            "section_number": [number % 100],
        }
        for number in range(ROW_COUNT)
    ]


def request_rows():
    return [
        {
            "id": f"request-{number}",
            "document_path": f"docs/{number % 100:03d}.md",
            "document_hash": f"hash-{number % 250:03d}",
            "status": ("pending", "processing", "completed", "failed")[number % 4],
            "created_at": None,
            "started_at": None,
            "completed_at": None,
            "error": None,
        }
        for number in range(ROW_COUNT)
    ]


def snapshot(db):
    result = {}
    for table_name in ("sections", "index_requests", "writer_heartbeat"):
        rows = db.open_table(table_name).to_arrow().to_pylist()
        result[table_name] = {
            "count": len(rows),
            "sha256": canonical_hash(rows),
        }
    return result


def filtered_ids(table, predicate):
    return sorted(row["id"] for row in table.search().where(predicate).to_list())


def run_strict_diagnosis(project_root, cache_root):
    types_url = (REPO / "packages/types/dist/index.js").as_uri()
    diagnostic_url = (
        REPO / "packages/server/dist/discovery/strict-diagnostic.js"
    ).as_uri()
    script = f"""
import {{ DEFAULT_CONFIG }} from {json.dumps(types_url)};
import {{ diagnoseStrictConfig }} from {json.dumps(diagnostic_url)};
const root = process.argv[1];
const config = structuredClone(DEFAULT_CONFIG);
config.project = {{ ...config.project, root }};
config.files = {{
  ...config.files,
  sources: ['docs/*.md'],
  exclude: [],
  respectGitignore: false,
}};
config.storage = {{
  ...config.storage,
  indexPath: '.search-docs/index',
  documentsPath: '.search-docs/documents',
}};
await diagnoseStrictConfig(config);
console.log('STRICT_DIAGNOSIS_PASSED');
"""
    environment = {
        **os.environ,
        "VIRTUAL_ENV": str(REPO / "packages/db-engine/.venv"),
        "UV_PROJECT_ENVIRONMENT": str(REPO / "packages/db-engine/.venv"),
        "UV_CACHE_DIR": str(cache_root / "uv-cache"),
        "UV_NO_SYNC": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(project_root)],
            cwd=REPO,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            f"strict diagnosis failed:\n{error.stdout}\n{error.stderr}"
        ) from error
    assert "STRICT_DIAGNOSIS_PASSED" in result.stdout, result.stdout


def run():
    original_argv = sys.argv
    sys.argv = ["worker.py", "--embedding-url=http://127.0.0.1:1"]
    try:
        with tempfile.TemporaryDirectory(prefix="issue183-scalar-index-") as directory:
            project_root = Path(directory) / "project"
            index_path = project_root / ".search-docs/index"
            documents_path = project_root / ".search-docs/documents"
            source_path = project_root / "docs"
            documents_path.mkdir(parents=True)
            source_path.mkdir(parents=True)
            for number in range(100):
                (source_path / f"{number:03d}.md").write_text(
                    f"# Fixture {number}\n\nScalar index test.\n"
                )
            worker = SearchDocsWorker(str(index_path))
            try:
                worker.vector_dimension = DIMENSION
                db = worker.db
                db.create_table("sections", schema=get_sections_schema(DIMENSION))
                db.create_table("index_requests", schema=get_index_requests_schema())
                db.create_table("writer_heartbeat", schema=get_writer_heartbeat_schema())
                db.open_table("sections").add(section_rows())
                db.open_table("index_requests").add(request_rows())

                before = snapshot(db)
                expected_pending = filtered_ids(
                    db.open_table("index_requests"), "status = 'pending'"
                )
                expected_dirty = filtered_ids(
                    db.open_table("sections"), "is_dirty = true"
                )

                original_open_table = db.open_table
                failure_seen = False

                class FaultingTable:
                    def __init__(self, table):
                        self.table = table

                    def __getattr__(self, name):
                        return getattr(self.table, name)

                    def create_scalar_index(self, column, **kwargs):
                        nonlocal failure_seen
                        if (
                            not failure_seen
                            and self.table.name == FAULT_TABLE
                            and column == FAULT_COLUMN
                        ):
                            failure_seen = True
                            raise RuntimeError("injected scalar-index create failure")
                        return self.table.create_scalar_index(column, **kwargs)

                db.open_table = lambda name: FaultingTable(original_open_table(name))
                first_started = time.perf_counter()
                worker.init_tables()
                first_seconds = time.perf_counter() - first_started
                db.open_table = original_open_table

                assert failure_seen, "the requested scalar-index failure was not injected"
                partial_indices = indices(db.open_table("index_requests"))
                assert ("status",) not in partial_indices
                assert ("document_path",) in partial_indices
                assert ("document_hash",) in partial_indices
                after_failure = snapshot(db)
                assert before == after_failure, "logical table rows changed after index failure"
                assert expected_pending == filtered_ids(
                    db.open_table("index_requests"), "status = 'pending'"
                )
                assert expected_dirty == filtered_ids(
                    db.open_table("sections"), "is_dirty = true"
                )

                before_strict = snapshot(db)
                run_strict_diagnosis(project_root, Path(directory))
                after_strict = snapshot(db)
                assert before_strict == after_strict, (
                    "read-only strict diagnosis changed logical table rows"
                )

                retry_started = time.perf_counter()
                worker.init_tables()
                retry_seconds = time.perf_counter() - retry_started
                recovered_indices = indices(db.open_table("index_requests"))
                assert ("status",) in recovered_indices
                after_retry = snapshot(db)
                assert before == after_retry, "logical table rows changed after index retry"
                assert expected_pending == filtered_ids(
                    db.open_table("index_requests"), "status = 'pending'"
                )
                assert expected_dirty == filtered_ids(
                    db.open_table("sections"), "is_dirty = true"
                )

                warm_started = time.perf_counter()
                worker.init_tables()
                warm_seconds = time.perf_counter() - warm_started
                assert before == snapshot(db), "warm index check changed logical rows"

                return {
                    "temporaryDatabase": True,
                    "rowsPerDataTable": ROW_COUNT,
                    "vectorDimension": DIMENSION,
                    "injectedFailure": f"{FAULT_TABLE}.{FAULT_COLUMN}",
                    "failureWasCaughtAndInitializationContinued": True,
                    "indicesAfterFailure": partial_indices,
                    "indicesAfterRetry": recovered_indices,
                    "logicalRowSnapshotsBeforeFailureAfterRetry": before,
                    "filterResultsUnchanged": True,
                    "strictDiagnosisPassesWithMissingScalarIndex": True,
                    "logicalRowsUnchangedAcrossStrictDiagnosis": True,
                    "elapsedSeconds": {
                        "firstPassWithOneInjectedFailureAndOtherIndexesCreated": round(
                            first_seconds, 4
                        ),
                        "retryOfMissingIndex": round(retry_seconds, 4),
                        "warmCheckWithAllIndexesPresent": round(warm_seconds, 4),
                    },
                    "scope": "direct SearchDocsWorker.init_tables(); no TS service startup, no native API interruption",
                }
            finally:
                worker.perf_logger.stop()
    finally:
        sys.argv = original_argv


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
