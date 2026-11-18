"""実 DB に保存された heartbeat を異なるタイムゾーンで読み取る。"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent
SCRIPT = r'''
import json, sys
from datetime import datetime, timedelta, timezone
import lancedb
from schemas import get_writer_heartbeat_schema
from worker import SearchDocsWorker

path, action, age = sys.argv[1:]
worker = SearchDocsWorker.__new__(SearchDocsWorker)
worker.db_path = path
worker.db = lancedb.connect(path)
if action == "write":
    table = worker.db.create_table("writer_heartbeat", schema=get_writer_heartbeat_schema())
    worker._write_counts = {"writer_heartbeat": 0}
    worker.update_heartbeat({"writer_id": "original", "host": "test", "pid": 1})
    table = worker.db.open_table("writer_heartbeat")
    if int(age):
        table.delete("writer_id IS NOT NULL")
        table.add([{"writer_id": "original", "host": "test", "pid": 1,
                    "state": "watching", "updated_at": datetime.now(timezone.utc) - timedelta(seconds=int(age))}])
    row = table.search().limit(1).to_list()[0]
    print(json.dumps({"schema": str(table.schema.field("updated_at").type),
                      "value": row["updated_at"].isoformat(),
                      "naive": row["updated_at"].tzinfo is None}))
else:
    print(json.dumps(worker.get_writer_heartbeat()))
'''


def run_process(path, zone, action, age):
    env = {**os.environ, "TZ": zone, "PYTHONPATH": str(PYTHON_DIR)}
    result = subprocess.run([sys.executable, "-c", SCRIPT, str(path), action, str(age)],
                            env=env, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


@pytest.mark.parametrize("writer_zone,reader_zone", [
    ("UTC", "UTC"), ("UTC", "Asia/Tokyo"), ("UTC", "America/Los_Angeles"),
    ("Asia/Tokyo", "America/Los_Angeles"), ("America/Los_Angeles", "Asia/Tokyo"),
])
@pytest.mark.parametrize("age", [0, 121])
def test_heartbeat_age_across_process_timezones(tmp_path, writer_zone, reader_zone, age):
    saved = run_process(tmp_path, writer_zone, "write", age)
    assert saved["schema"] == "timestamp[us, tz=UTC]"
    assert not saved["naive"]
    heartbeat = run_process(tmp_path, reader_zone, "read", age)["heartbeat"]
    assert age - 1 <= heartbeat["age_seconds"] < age + 15
    assert heartbeat["updated_at"].endswith("+00:00")


def test_legacy_naive_utc_timestamp(tmp_path):
    import lancedb
    from datetime import datetime, timezone
    sys.path.insert(0, str(PYTHON_DIR))
    from schemas import get_writer_heartbeat_schema

    db = lancedb.connect(str(tmp_path))
    table = db.create_table("writer_heartbeat", schema=get_writer_heartbeat_schema())
    table.add([{ "writer_id": "legacy", "host": "test", "pid": 1,
                 "state": "watching", "updated_at": datetime.now(timezone.utc).replace(tzinfo=None) }])
    assert str(table.schema.field("updated_at").type) == "timestamp[ms]"
    assert table.search().limit(1).to_list()[0]["updated_at"].tzinfo is None
    heartbeat = run_process(tmp_path, "Asia/Tokyo", "read", 0)["heartbeat"]
    assert 0 <= heartbeat["age_seconds"] < 15
