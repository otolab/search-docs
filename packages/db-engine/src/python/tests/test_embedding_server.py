"""Embeddingサーバのliveness/readinessと自己probeのテスト"""

import json
import math
import sys
import threading
import types
import urllib.error
import urllib.request
from pathlib import Path

import pytest

python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from embedding_server import (  # noqa: E402
    EmbeddingHealthState,
    EmbeddingRequestHandler,
    ThreadingHTTPServer,
    download_model,
    main,
)


class FakeModel:
    model_name = 'fake-ruri'
    dimension = 3

    def __init__(self):
        self.fail = False
        self.calls = 0
        self.output_dimension = self.dimension
        self.output_value = 0.1

    def encode(self, texts, dimension=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError('inference unavailable')
        output_dimension = self.output_dimension
        return [[self.output_value] * output_dimension for _ in texts]


def get_json(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status, json.loads(response.read().decode('utf-8'))


@pytest.fixture
def reset_handler():
    original = (
        EmbeddingRequestHandler.model,
        EmbeddingRequestHandler.health_state,
        EmbeddingRequestHandler.runtime,
        EmbeddingRequestHandler._fallback_health_state,
    )
    yield
    EmbeddingRequestHandler.model = original[0]
    EmbeddingRequestHandler.health_state = original[1]
    EmbeddingRequestHandler.runtime = original[2]
    EmbeddingRequestHandler._fallback_health_state = original[3]


def test_self_probe_updates_readiness_and_failure_count():
    model = FakeModel()
    state = EmbeddingHealthState(model, runtime='test', start_worker=False)

    assert state.ready is False
    assert state.probe() is True
    assert state.ready is True
    assert state.consecutive_failures == 0
    assert state.last_probe['success'] is True
    assert state.health_payload()['runtime'] == 'test'

    model.fail = True
    assert state.probe() is False
    assert state.ready is False
    assert state.consecutive_failures == 1
    assert state.last_probe['success'] is False

    state.stop()


def test_self_probe_rejects_wrong_dimension_and_non_finite_values():
    model = FakeModel()
    state = EmbeddingHealthState(model, start_worker=False)

    model.output_dimension = 2
    assert state.probe() is False
    assert state.ready is False
    assert 'dimension 2' in state.last_probe['error']

    model.output_dimension = model.dimension
    model.output_value = math.nan
    assert state.probe() is False
    assert state.ready is False
    assert 'non-finite' in state.last_probe['error']

    state.stop()


def test_download_model_uses_runtime_default_repositories_and_hub_cache(monkeypatch):
    calls = []

    def fake_snapshot_download(*, repo_id):
        calls.append(repo_id)
        return f'/fake/huggingface/{repo_id}'

    monkeypatch.setattr('os.path.exists', lambda _path: False)
    monkeypatch.setitem(
        sys.modules,
        'huggingface_hub',
        types.SimpleNamespace(snapshot_download=fake_snapshot_download),
    )

    assert download_model('onnx') == '/fake/huggingface/sirasagi62/ruri-v3-30m-ONNX'
    assert download_model('torch') == '/fake/huggingface/cl-nagoya/ruri-v3-30m'
    assert download_model('onnx', 'org/custom-ruri') == '/fake/huggingface/org/custom-ruri'
    assert calls == [
        'sirasagi62/ruri-v3-30m-ONNX',
        'cl-nagoya/ruri-v3-30m',
        'org/custom-ruri',
    ]


def test_download_model_rejects_unknown_runtime():
    with pytest.raises(ValueError, match='Unsupported runtime'):
        download_model('unsupported')


def test_download_only_fetches_model_without_starting_http_server(monkeypatch):
    requested = []
    monkeypatch.setattr(
        sys,
        'argv',
        ['embedding_server.py', '--download-only', '--runtime=torch'],
    )
    monkeypatch.setattr(
        'embedding_server.download_model',
        lambda runtime, model_repo=None: requested.append((runtime, model_repo)),
    )

    class UnexpectedServer:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError('download-only must not start an HTTP server')

    monkeypatch.setattr('embedding_server.ThreadingHTTPServer', UnexpectedServer)

    main()

    assert requested == [('torch', None)]


def test_health_ready_and_deep_probe_endpoints(reset_handler):
    model = FakeModel()
    state = EmbeddingHealthState(model, runtime='test', start_worker=False)
    EmbeddingRequestHandler.model = model
    EmbeddingRequestHandler.health_state = state

    server = ThreadingHTTPServer(('127.0.0.1', 0), EmbeddingRequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}'

    try:
        health_status, health = get_json(f'{base_url}/health')
        assert health_status == 200
        assert health['status'] == 'ok'
        assert health['ready'] is False
        assert health['lastProbe'] is None

        with pytest.raises(urllib.error.HTTPError) as not_ready:
            get_json(f'{base_url}/ready')
        assert not_ready.value.code == 503

        deep_status, deep = get_json(f'{base_url}/health?deep=1')
        assert deep_status == 200
        assert deep['ready'] is True
        assert deep['deepProbe']['success'] is True

        ready_status, ready = get_json(f'{base_url}/ready')
        assert ready_status == 200
        assert ready['status'] == 'ready'

        model.fail = True
        degraded_status, degraded = get_json(f'{base_url}/health?deep=1')
        assert degraded_status == 200
        assert degraded['status'] == 'degraded'
        assert degraded['ready'] is False
        assert degraded['consecutiveFailures'] == 1

        with pytest.raises(urllib.error.HTTPError) as failed_ready:
            get_json(f'{base_url}/ready')
        assert failed_ready.value.code == 503
    finally:
        state.stop()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
