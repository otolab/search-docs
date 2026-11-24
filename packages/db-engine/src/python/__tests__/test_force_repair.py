import sys
import tempfile
import unittest
from pathlib import Path

import lancedb
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schemas import get_index_requests_schema, get_sections_schema, get_writer_heartbeat_schema
from worker import SearchDocsWorker


class UnreadableTable:
    def count_rows(self):
        raise OSError('temporary read failure')


class DatabaseProxy:
    def __init__(self, db, unreadable):
        self.db = db
        self.unreadable = unreadable

    def table_names(self):
        return self.db.table_names()

    def open_table(self, name):
        return UnreadableTable() if name == self.unreadable else self.db.open_table(name)

    def drop_table(self, name):
        return self.db.drop_table(name)

    def create_table(self, name, **kwargs):
        return self.db.create_table(name, **kwargs)


class ForceRepairTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='issue160-force-')
        self.addCleanup(self.directory.cleanup)
        self.db = lancedb.connect(self.directory.name)
        self.db.create_table('sections', schema=get_sections_schema(4))
        self.db.create_table('index_requests', data=pa.Table.from_pylist([
            {'id': 'one', 'document_path': 'safe.md', 'status': 'pending'}
        ], schema=get_index_requests_schema()))
        self.db.create_table('writer_heartbeat', schema=get_writer_heartbeat_schema())
        self.db.create_table('embedding_identity', data=[{'dimension': 4}])
        self.worker = SearchDocsWorker.__new__(SearchDocsWorker)
        self.worker.db = DatabaseProxy(self.db, 'sections')
        self.worker.read_only = False

    def test_only_selected_table_is_recreated(self):
        before = self.db.open_table('index_requests').to_arrow().to_pylist()
        self.worker.recreate_repair_table({'table': 'sections', 'dimension': 4})
        self.assertEqual(self.db.open_table('sections').count_rows(), 0)
        self.assertEqual(self.db.open_table('index_requests').to_arrow().to_pylist(), before)
        self.assertEqual(self.db.open_table('writer_heartbeat').count_rows(), 0)

    def test_dimension_mismatch_does_not_drop(self):
        with self.assertRaisesRegex(ValueError, 'dimension'):
            self.worker.recreate_repair_table({'table': 'sections', 'dimension': 8})
        self.assertIn('sections', self.db.table_names())

    def test_readable_or_read_only_is_rejected(self):
        self.worker.db = DatabaseProxy(self.db, None)
        with self.assertRaisesRegex(ValueError, 'readable'):
            self.worker.recreate_repair_table({'table': 'sections', 'dimension': 4})
        self.worker.read_only = True
        with self.assertRaisesRegex(ValueError, 'read-only'):
            self.worker.recreate_repair_table({'table': 'sections', 'dimension': 4})

    def test_normal_repair_does_not_drop_on_transient_error(self):
        result = self.worker.repair_tables()
        self.assertEqual(result['tables']['sections']['status'], 'unreadable')
        self.assertIn('sections', self.db.table_names())


if __name__ == '__main__':
    unittest.main()
