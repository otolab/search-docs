import io
import json
import os
import urllib.error
from unittest.mock import patch

import pytest
from embedding import OpenAICompatibleEmbeddingModel


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def test_openai_response_order_and_auth():
    model = OpenAICompatibleEmbeddingModel('https://example.test/v1', 2, 'example', 'secret')
    response = {'data': [{'index': 1, 'embedding': [3, 4]}, {'index': 0, 'embedding': [1, 2]}]}
    with patch('urllib.request.urlopen', return_value=Response(json.dumps(response).encode())) as call:
        assert model.encode(['a', 'b']) == [[1, 2], [3, 4]]
        request = call.call_args.args[0]
        assert request.get_header('Authorization') == 'Bearer secret'
        assert json.loads(request.data)['dimensions'] == 2


@pytest.mark.parametrize('response', [
    {'data': [{'index': 0, 'embedding': [1]}]},
    {'data': [{'index': 0, 'embedding': [1, None]}]},
    {'data': [{'index': 1, 'embedding': [1, 2]}]},
    {'data': []},
])
def test_invalid_openai_response(response):
    model = OpenAICompatibleEmbeddingModel('https://example.test/v1', 2, 'example', 'secret')
    with patch('urllib.request.urlopen', return_value=Response(json.dumps(response).encode())):
        with pytest.raises(RuntimeError, match='dimension 2'):
            model.encode('test')


def test_http_error_does_not_include_response_body():
    model = OpenAICompatibleEmbeddingModel('https://example.test/v1', 2, 'example', 'secret')
    error = urllib.error.HTTPError('https://example.test/v1', 401, 'secret', {}, None)
    with patch('urllib.request.urlopen', side_effect=error):
        with pytest.raises(RuntimeError, match='HTTP 401') as exc:
            model.encode('test')
    assert 'secret' not in str(exc.value)


def test_endpoint_identity_is_hashed_and_normalized(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from embedding import initialize_openai_provider

    monkeypatch.setattr('sys.argv', ['worker.py', '--embedding-dimension=2'])
    monkeypatch.setenv('SEARCH_DOCS_EMBEDDING_OPTIONS', json.dumps({'model': 'example', 'apiKey': 'top-secret'}))
    identities = []
    worker = SimpleNamespace(embedding_url='https://EXAMPLE.test:443/v1/', read_only=True,
                             _check_embedding_identity=lambda *args: identities.append(args))
    with patch.object(OpenAICompatibleEmbeddingModel, 'encode', MagicMock(return_value=[1, 2])):
        initialize_openai_provider(worker)
        worker.embedding_url = 'https://example.test/v1'
        initialize_openai_provider(worker)
        worker.embedding_url = 'https://example.test/other'
        initialize_openai_provider(worker)
    assert identities[0] == identities[1]
    assert identities[0] != identities[2]
    assert identities[0][2].startswith('endpoint-sha256:')
    assert 'example.test' not in identities[0][2]
    assert 'top-secret' not in repr(identities)


def test_legacy_openai_identity_requires_rebuild_but_builtin_still_matches():
    from types import SimpleNamespace
    from worker import SearchDocsWorker

    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    worker.vector_dimension = 2
    old = {'provider': 'openai-compatible', 'model': 'example', 'digest': '', 'dimension': 2}
    table = SimpleNamespace(to_arrow=lambda: SimpleNamespace(to_pylist=lambda: [old]))
    worker.db = SimpleNamespace(table_names=lambda: ['embedding_identity'], open_table=lambda _: table)
    with pytest.raises(RuntimeError, match='rebuild the index'):
        worker._check_embedding_identity('openai-compatible', 'example', 'endpoint-sha256:abc')
    old.update(provider='builtin', model='ruri-v3-30m-onnx')
    worker._check_embedding_identity('builtin', 'ruri-v3-30m-onnx', '')


def test_new_provider_receives_custom_options_without_worker_changes(monkeypatch):
    from embedding import EMBEDDING_PROVIDERS
    from worker import SearchDocsWorker

    monkeypatch.setenv('SEARCH_DOCS_EMBEDDING_PROVIDER', 'test-provider')
    monkeypatch.setenv('SEARCH_DOCS_EMBEDDING_OPTIONS', json.dumps({'region': 'asia', 'token': 'secret'}))
    monkeypatch.setitem(EMBEDDING_PROVIDERS, 'test-provider', lambda _: json.loads(
        os.environ['SEARCH_DOCS_EMBEDDING_OPTIONS']))
    worker = SearchDocsWorker.__new__(SearchDocsWorker)
    assert worker.init_model() == {'region': 'asia', 'token': 'secret'}
