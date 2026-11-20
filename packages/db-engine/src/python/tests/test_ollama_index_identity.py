import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker import SearchDocsWorker
from schemas import get_sections_schema


@pytest.fixture
def ollama(monkeypatch):
    state = {'model': 'example:latest', 'digest': 'sha256:one', 'dimension': 3, 'fail': False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_json(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/api/tags':
                self.send_json(200, {'models': [{'name': state['model'], 'digest': state['digest']}]})
            elif self.path == '/health' and state.get('builtin'):
                self.send_json(200, {'model': 'ruri-v3-30m-onnx', 'vectorDimension': 3})
            else:
                self.send_json(404, {})

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['request'] = data
            if state['fail']:
                self.send_json(500, {'error': 'failed'})
            else:
                if state.get('change_during_embed'):
                    state['digest'] = 'sha256:changed'
                self.send_json(200, {'embeddings': [[0.1] * state['dimension'] for _ in data['input']]})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('EMBEDDING_URL', f'http://127.0.0.1:{server.server_port}')
    monkeypatch.setenv('EMBEDDING_MODEL', 'example')
    monkeypatch.setattr(sys, 'argv', ['worker', '--embedding-dimension=3'])
    yield state
    server.shutdown()
    server.server_close()
    thread.join()


def make_worker(path):
    return SearchDocsWorker(str(path))


def test_ollama_restart_model_and_dimension_mismatches(tmp_path, ollama, monkeypatch):
    first = make_worker(tmp_path)
    assert first.init_model()['dimension'] == 3
    assert ollama['request']['model'] == 'example:latest'
    first.perf_logger.stop()
    restarted = make_worker(tmp_path)
    assert restarted.init_model()['success']
    restarted.perf_logger.stop()
    ollama['digest'] = 'sha256:changed'
    changed = make_worker(tmp_path)
    with pytest.raises(RuntimeError, match='differs from the index'):
        changed.init_model()
    changed.perf_logger.stop()
    ollama['digest'] = 'sha256:one'
    ollama['dimension'] = 4
    monkeypatch.setattr(sys, 'argv', ['worker', '--embedding-dimension=4'])
    changed_dimension = make_worker(tmp_path)
    with pytest.raises(RuntimeError, match='differs from the index'):
        changed_dimension.init_model()
    changed_dimension.perf_logger.stop()


def test_ollama_requires_model_and_valid_probe(tmp_path, ollama, monkeypatch):
    monkeypatch.delenv('EMBEDDING_MODEL')
    worker = make_worker(tmp_path)
    with pytest.raises(RuntimeError, match='explicit EMBEDDING_MODEL'):
        worker.init_model()
    monkeypatch.setenv('EMBEDDING_MODEL', 'missing')
    with pytest.raises(RuntimeError, match='unavailable'):
        worker.init_model()
    monkeypatch.setenv('EMBEDDING_MODEL', 'example')
    ollama['dimension'] = 2
    with pytest.raises(RuntimeError, match="Invalid embedding"):
        worker.init_model()
    assert 'embedding_identity' not in worker.db.table_names()
    worker.perf_logger.stop()


def test_legacy_index_rejects_external_model_without_modifying_data(tmp_path, ollama):
    worker = make_worker(tmp_path)
    worker.db.create_table('sections', schema=get_sections_schema(3))
    with pytest.raises(RuntimeError, match='no embedding identity'):
        worker.init_model()
    assert 'embedding_identity' not in worker.db.table_names()
    assert worker.db.open_table('sections').schema.field('vector').type.list_size == 3
    worker.perf_logger.stop()


def test_legacy_builtin_index_is_preserved(tmp_path, ollama):
    ollama['builtin'] = True
    worker = make_worker(tmp_path)
    worker.db.create_table('sections', schema=get_sections_schema(3))
    assert worker.init_model()['model_name'] == 'ruri-v3-30m-onnx'
    assert worker.db.open_table('embedding_identity').to_arrow().to_pylist()[0]['provider'] == 'builtin'
    worker.perf_logger.stop()


def test_index_and_search_then_reject_live_model_change(tmp_path, ollama):
    worker = make_worker(tmp_path)
    worker.init_model()
    section = {
        'id': 'one', 'document_path': 'test.md', 'heading': '見出し', 'depth': 1,
        'content': '日本語の文書', 'token_count': 10, 'order': 0,
        'is_dirty': False, 'document_hash': 'hash', 'start_line': 1,
        'end_line': 2, 'section_number': [1],
        'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-01T00:00:00Z',
    }
    assert worker.add_sections({'sections': [section]})['count'] == 1
    assert worker.search({'query': '文書'})['results'][0]['document_path'] == 'test.md'
    ollama['digest'] = 'sha256:changed'
    with pytest.raises(RuntimeError, match='changed'):
        worker.search({'query': '文書'})
    assert worker.db.open_table('sections').count_rows() == 1
    worker.perf_logger.stop()


def test_fallback_to_builtin_cannot_reuse_ollama_index(tmp_path, ollama):
    worker = make_worker(tmp_path)
    worker.init_model()
    worker.perf_logger.stop()
    ollama['builtin'] = True
    fallback = make_worker(tmp_path)
    with pytest.raises(RuntimeError, match='differs from the index'):
        fallback.init_model()
    fallback.perf_logger.stop()


def test_model_change_during_embedding_fails_before_write(tmp_path, ollama):
    worker = make_worker(tmp_path)
    worker.init_model()
    ollama['change_during_embed'] = True
    section = {
        'id': 'one', 'document_path': 'test.md', 'heading': '題', 'depth': 1,
        'content': '本文', 'token_count': 2, 'order': 0, 'is_dirty': False,
        'document_hash': 'hash', 'start_line': 1, 'end_line': 2, 'section_number': [1],
        'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-01T00:00:00Z',
    }
    with pytest.raises(RuntimeError, match='changed'):
        worker.add_sections({'sections': [section]})
    assert worker.db.open_table('sections').count_rows() == 0
    worker.perf_logger.stop()
