import io
import json
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
