"""Duplicate diagnosis uses a pinned LanceDB snapshot and never writes sections."""
import lancedb
import pyarrow as pa
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from duplicate_diagnostics import diagnose


def row(id, parent, number, content='same', path='a.md'):
    return {'id': id, 'document_path': path, 'document_hash': 'hash', 'parent_id': parent,
            'heading': 'heading', 'depth': len(number), 'content': content, 'order': 0,
            'start_line': 1, 'end_line': 2, 'section_number': number}


def test_complete_trees_and_ambiguous_groups(tmp_path):
    db = lancedb.connect(str(tmp_path))
    rows = [row('r1', None, []), row('c1', 'r1', [1]), row('r2', None, []), row('c2', 'r2', [1]),
            row('r3', None, [], 'different', 'b.md'), row('c3', 'missing', [1], path='c.md')]
    table = db.create_table('sections', pa.Table.from_pylist(rows))
    version = table.version
    result = diagnose(db)
    assert result['complete']
    assert result['candidates'] == [{'path': 'a.md', 'rootIds': ['r1', 'r2'], 'rootCount': 2}]
    assert result['ambiguous'] == 1
    assert table.version == version
    assert table.count_rows() == len(rows)


def test_scan_limit_is_incomplete(tmp_path):
    db = lancedb.connect(str(tmp_path))
    db.create_table('sections', pa.Table.from_pylist([row('r1', None, []), row('r2', None, [])]))
    result = diagnose(db, max_rows=1)
    assert not result['complete']
    assert result['candidates'] == []
    assert not diagnose(db, max_bytes=1)['complete']


def test_same_headings_with_different_content_and_cycles_are_not_candidates(tmp_path):
    db = lancedb.connect(str(tmp_path))
    rows = [row('r1', None, [], 'one'), row('r2', None, [], 'two'),
            row('cycle1', 'cycle2', [1], path='cycle.md'),
            row('cycle2', 'cycle1', [2], path='cycle.md')]
    db.create_table('sections', pa.Table.from_pylist(rows))
    result = diagnose(db)
    assert result['candidates'] == []
    assert result['ambiguous'] == 1


def test_skip_targets_only_captured_pending_ids(tmp_path):
    from datetime import datetime
    from schemas import get_index_requests_schema
    from worker import SearchDocsWorker
    db = lancedb.connect(str(tmp_path))
    table = db.create_table('index_requests', schema=get_index_requests_schema())
    def request(id, hash, status='pending'):
        return {'id': id, 'document_path': 'a.md', 'document_hash': hash, 'status': status,
                'created_at': datetime.now(), 'started_at': None, 'completed_at': None, 'error': None}
    table.add([request('same', 'a'), request('newer', 'b'), request('late', 'a'), request('already', 'a', 'processing')])
    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker._index_requests_table = table
    worker.skip_captured_index_requests({'documentPath': 'a.md', 'ids': ['same', 'already']})
    result = {r['id']: r['status'] for r in table.search().limit(None).to_list()}
    assert result == {'same': 'skipped', 'newer': 'pending', 'late': 'pending', 'already': 'processing'}


def test_concurrent_add_after_checkout_is_not_in_snapshot(tmp_path):
    db = lancedb.connect(str(tmp_path))
    writer = db.create_table('sections', pa.Table.from_pylist([row('r1', None, [])]))
    class TableProxy:
        def __init__(self, table):
            self.table = table
        @property
        def version(self):
            return self.table.version
        def checkout(self, version):
            self.table.checkout(version)
            writer.add(pa.Table.from_pylist([row('r2', None, [])], schema=writer.schema))
        def search(self):
            return self.table.search()
    class DBProxy:
        def open_table(self, name):
            return TableProxy(db.open_table(name))
    result = diagnose(DBProxy())
    assert result['complete'] and result['rowsRead'] == 1
    assert result['candidates'] == []
    assert writer.count_rows() == 2
