"""Embeddingサーバのliveness/readinessと自己probeのテスト"""

import json
import sys
import threading
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
)


class FakeModel:
    model_name = 'fake-ruri'
    dimension = 3

    def __init__(self):
        self.fail = False
        self.calls = 0

    def encode(self, texts, dimension=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError('inference unavailable')
        output_dimension = dimension or self.dimension
        return [[0.1] * output_dimension for _ in texts]


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

