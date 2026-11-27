"""Exercise the supported embedding server main with an isolated fake model."""
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

PYTHON_DIR = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = '''
import sys, types
embedding = types.ModuleType('embedding'); embedding.RuriEmbedding = object
sys.modules['embedding'] = embedding
onnx = types.ModuleType('embedding_onnx')
class Model:
    def __init__(self, model_path, dimension):
        self.dimension = dimension
        self.model_name = 'fake-model'
    def load(self): return True
    def encode(self, texts, dimension=None): return [[0.0] * (dimension or self.dimension)]
onnx.ONNXEmbedding = Model
sys.modules['embedding_onnx'] = onnx
import embedding_server
embedding_server.main()
'''


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class EmbeddingMainTest(unittest.TestCase):
    def test_server_main_stops_and_restarts(self):
        port = free_port()
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            launcher = root / 'launcher.py'
            launcher.write_text(
                f"import sys; sys.path.insert(0, {str(PYTHON_DIR)!r})\n" + LAUNCHER
            )
            (root / 'pyproject.toml').write_text(
                '[project]\nname = "embedding-main-test"\nversion = "0.0.0"\nrequires-python = ">=3.11"\n'
            )
            uv = shutil.which('uv')
            if not uv:
                self.skipTest('uv is required for the real launcher path')
            env = dict(
                os.environ,
                PYTHONPATH=str(PYTHON_DIR),
                UV_CACHE_DIR=str(root / 'cache'),
                HF_HUB_OFFLINE='1',
                TRANSFORMERS_OFFLINE='1',
            )
            for _ in range(2):
                process = subprocess.Popen(
                    [
                        uv, 'run', '--project', temp, '--offline', '--no-sync',
                        '--no-managed-python', 'python', str(launcher),
                        '--port', str(port), '--model-path', temp,
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=env,
                )
                try:
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            self.fail(f'embedding server exited early with {process.returncode}')
                        try:
                            with urllib.request.urlopen(
                                f'http://127.0.0.1:{port}/health',
                                timeout=.25,
                            ) as response:
                                self.assertEqual(response.status, 200)
                            break
                        except (OSError, urllib.error.URLError):
                            time.sleep(.05)
                    else:
                        self.fail('embedding server did not become healthy')

                    process.terminate()
                    process.wait(timeout=5)
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        probe.bind(('127.0.0.1', port))
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
