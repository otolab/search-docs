#!/usr/bin/env python3
"""
Embedding Server - HTTP APIでEmbedding機能を提供
複数のMCPサーバからEmbeddingモデルを共有利用するためのサーバ

API:
  POST /encode      - テキストをベクトル化
  POST /api/embed   - Ollama API互換のEmbedding
  GET  /health      - livenessとモデル情報（?deep=1で同期probe）
  GET  /ready       - 直近の自己probeに基づくreadiness
"""

import sys
import argparse
import json
import time
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from embedding import RuriEmbedding


class EmbeddingHealthState:
    """モデルの自己probe結果を保持し、バックグラウンドで更新する。"""

    def __init__(
        self,
        model: Any,
        runtime: str = 'unknown',
        probe_interval: float = 45.0,
        start_worker: bool = True,
    ):
        self.model = model
        self.runtime = runtime
        self.probe_interval = max(1.0, float(probe_interval))
        self.started_at = time.time()
        self.last_probe: Optional[Dict[str, Any]] = None
        self.consecutive_failures = 0
        self.ready = False
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        if start_worker:
            self.start()

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    @staticmethod
    def _validate_vectors(vectors: Any) -> None:
        if not isinstance(vectors, list) or not vectors:
            raise RuntimeError('self probe returned no vectors')
        vector = vectors[0] if isinstance(vectors[0], list) else vectors
        if not isinstance(vector, list) or not vector:
            raise RuntimeError('self probe returned an invalid vector')
        if not all(isinstance(value, (int, float)) for value in vector):
            raise RuntimeError('self probe returned a non-numeric vector')

    def probe(self) -> bool:
        """短い入力をencodeし、直近結果と連続失敗回数を更新する。"""
        started = time.perf_counter()
        success = False
        error: Optional[str] = None
        try:
            with self._lock:
                vectors = self.model.encode(
                    ['search-docs self health probe'],
                    dimension=self.model.dimension,
                )
            self._validate_vectors(vectors)
            success = True
        except Exception as exc:  # noqa: BLE001 - probe failure is reported as state
            error = str(exc)

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        with self._lock:
            self.ready = success
            if success:
                self.consecutive_failures = 0
            else:
                self.consecutive_failures += 1
            self.last_probe = {
                'at': self._timestamp(),
                'latencyMs': latency_ms,
                'success': success,
                **({'error': error} if error else {}),
            }

        if not success:
            sys.stderr.write(
                f'[EmbeddingServer] Self probe failed '
                f'(consecutive failures: {self.consecutive_failures}): {error}\n'
            )
            sys.stderr.flush()
        return success

    def _worker(self) -> None:
        while not self._stop_event.is_set():
            self.probe()
            self._stop_event.wait(self.probe_interval)

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._worker,
                name='embedding-self-probe',
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def encode(self, texts: Any, dimension: Optional[int] = None) -> Any:
        """通常のリクエストもprobeと同じロックでモデルを呼び出す。"""
        with self._lock:
            return self.model.encode(texts, dimension=dimension)

    def health_payload(self) -> Dict[str, Any]:
        with self._lock:
            payload: Dict[str, Any] = {
                'status': 'degraded' if self.last_probe and not self.ready else 'ok',
                'model': self.model.model_name,
                'vectorDimension': self.model.dimension,
                'ready': self.ready,
                'uptimeSeconds': max(0, int(time.time() - self.started_at)),
                'lastProbe': self.last_probe,
                'consecutiveFailures': self.consecutive_failures,
                'runtime': self.runtime,
            }
            return payload


class EmbeddingRequestHandler(BaseHTTPRequestHandler):
    """Embedding Server のHTTPリクエストハンドラ"""

    # テストや既存の埋め込み利用者が差し替えられるクラス変数。
    model: Any = None
    health_state: Optional[EmbeddingHealthState] = None
    runtime: str = 'unknown'
    _fallback_health_state: Optional[EmbeddingHealthState] = None

    @classmethod
    def _get_health_state(cls) -> EmbeddingHealthState:
        if cls.health_state is not None:
            return cls.health_state
        if cls._fallback_health_state is None:
            if cls.model is None:
                raise RuntimeError('Embedding model is not initialized')
            cls._fallback_health_state = EmbeddingHealthState(
                cls.model,
                runtime=cls.runtime,
                start_worker=False,
            )
        return cls._fallback_health_state

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == '/health':
            self._handle_health(query)
        elif parsed.path == '/ready':
            self._handle_ready()
        elif parsed.path == '/api/tags':
            self._handle_tags()
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/encode':
            self._handle_encode()
        elif parsed.path == '/api/embed':
            self._handle_ollama_embed()
        else:
            self._send_json(404, {'error': 'Not found'})

    def _handle_health(self, query: Optional[Dict[str, List[str]]] = None):
        """liveness。deep=1/probe=1の場合はリクエスト内でprobeする。"""
        state = self._get_health_state()
        query = query or {}
        deep = query.get('deep', ['0'])[0] == '1' or query.get('probe', ['0'])[0] == '1'
        if deep:
            probe_success = state.probe()
            payload = state.health_payload()
            payload['deepProbe'] = {
                'success': probe_success,
                'lastProbe': payload['lastProbe'],
            }
            self._send_json(200, payload)
            return
        self._send_json(200, state.health_payload())

    def _handle_ready(self):
        """直近の自己probe成功時のみ200を返すreadinessエンドポイント。"""
        payload = self._get_health_state().health_payload()
        if not payload['ready']:
            payload['status'] = 'not_ready'
            if payload['lastProbe'] is None:
                payload['error'] = 'self probe has not completed'
            else:
                payload['error'] = 'last self probe failed'
            self._send_json(503, payload)
            return
        payload['status'] = 'ready'
        self._send_json(200, payload)

    def _handle_tags(self):
        """Ollama互換 /api/tags - 利用可能なモデル一覧"""
        state = self._get_health_state()
        self._send_json(200, {
            'models': [{
                'name': state.model.model_name,
                'model': state.model.model_name,
                'details': {
                    'family': 'embedding',
                    'parameter_size': '30M',
                },
            }],
        })

    def _read_json_body(self) -> Dict[str, Any]:
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        return json.loads(body.decode('utf-8'))

    def _handle_encode(self):
        """テキストをベクトル化"""
        try:
            data = self._read_json_body()
            texts: List[str] = data.get('texts', [])
            dimension: int = data.get('dimension', self._get_health_state().model.dimension)

            if not texts:
                self._send_json(400, {'error': 'texts is required and must be non-empty'})
                return

            # バッチエンコード
            vectors = self._get_health_state().encode(texts, dimension=dimension)

            # encode()は単一文字列の場合List[float]を返すが、ここでは常に
            # リストで渡しているのでList[List[float]]が返る。
            self._send_json(200, {'vectors': vectors})

        except json.JSONDecodeError:
            self._send_json(400, {'error': 'Invalid JSON'})
        except Exception as exc:  # noqa: BLE001 - API error is returned to caller
            sys.stderr.write(f'[EmbeddingServer] Error in /encode: {exc}\n')
            sys.stderr.flush()
            self._send_json(500, {'error': str(exc)})

    def _handle_ollama_embed(self):
        """Ollama API互換のEmbedding (/api/embed)"""
        try:
            start_time = time.time()
            data = self._read_json_body()

            # Ollama API形式: {"model": "ruri", "input": "text" | ["text1"],
            # "dimensions": 256, "truncate": true}
            input_data = data.get('input')
            if input_data is None:
                self._send_json(400, {'error': 'input is required'})
                return

            if isinstance(input_data, str):
                texts = [input_data]
            elif isinstance(input_data, list):
                texts = input_data
            else:
                self._send_json(400, {'error': 'input must be a string or array of strings'})
                return

            dimension = data.get('dimensions', self._get_health_state().model.dimension)
            vectors = self._get_health_state().encode(texts, dimension=dimension)

            end_time = time.time()
            duration_ns = int((end_time - start_time) * 1e9)
            response = {
                'model': self._get_health_state().model.model_name,
                'embeddings': vectors,
                'total_duration': duration_ns,
                'load_duration': 0,
                'prompt_eval_count': len(texts),
            }
            self._send_json(200, response)

        except json.JSONDecodeError:
            self._send_json(400, {'error': 'Invalid JSON'})
        except Exception as exc:  # noqa: BLE001 - API error is returned to caller
            sys.stderr.write(f'[EmbeddingServer] Error in /api/embed: {exc}\n')
            sys.stderr.flush()
            self._send_json(500, {'error': str(exc)})

    def _send_json(self, status: int, data: dict):
        """JSONレスポンスを送信"""
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        """ログをstderrに出力（デフォルトの挙動を維持しつつフォーマット統一）"""
        sys.stderr.write(f'[EmbeddingServer] {args[0]} {args[1]} {args[2]}\n')
        sys.stderr.flush()


def resolve_onnx_model_path() -> str:
    """ONNXモデルのパスを解決。Docker → HuggingFace Hub"""
    import os

    # 1. Docker内蔵パス
    docker_path = '/app/.cache/models/ruri-v3-30m-onnx'
    if os.path.exists(os.path.join(docker_path, 'onnx', 'model.onnx')):
        return docker_path

    # 2. HuggingFace Hubからダウンロード（キャッシュ済みなら即時返却）
    from huggingface_hub import snapshot_download
    sys.stderr.write('[EmbeddingServer] Downloading ONNX model from HuggingFace Hub...\n')
    sys.stderr.flush()
    local_dir = snapshot_download('sirasagi62/ruri-v3-30m-ONNX')
    sys.stderr.write(f'[EmbeddingServer] Model downloaded to: {local_dir}\n')
    sys.stderr.flush()
    return local_dir


def main():
    parser = argparse.ArgumentParser(description='search-docs Embedding Server')
    parser.add_argument('--port', type=int, default=8080, help='Listen port (default: 8080)')
    parser.add_argument('--model', type=str, default='cl-nagoya/ruri-v3-30m', help='Embedding model name (torch)')
    parser.add_argument('--runtime', type=str, choices=['onnx', 'torch'], default='onnx', help='Runtime (default: onnx)')
    parser.add_argument('--model-path', type=str, default=None, help='ONNX model path')
    parser.add_argument('--dimension', type=int, default=256, help='Vector dimension (default: 256)')
    parser.add_argument(
        '--probe-interval',
        type=float,
        default=45.0,
        help='Self-probe interval in seconds (default: 45)',
    )
    args = parser.parse_args()

    # モデルをロード
    if args.runtime == 'onnx':
        from embedding_onnx import ONNXEmbedding
        model_path = args.model_path or resolve_onnx_model_path()
        sys.stderr.write(f'[EmbeddingServer] Loading ONNX model from: {model_path}\n')
        sys.stderr.flush()
        model = ONNXEmbedding(model_path=model_path, dimension=args.dimension)
    else:
        sys.stderr.write(f'[EmbeddingServer] Loading torch model: {args.model}\n')
        sys.stderr.flush()
        model = RuriEmbedding(model_name=args.model, dimension=args.dimension)

    if not model.load():
        sys.stderr.write('[EmbeddingServer] Failed to load model\n')
        sys.exit(1)

    sys.stderr.write(f'[EmbeddingServer] Model loaded: {model.model_name} ({model.dimension}d)\n')
    sys.stderr.flush()

    # サーバ起動
    EmbeddingRequestHandler.model = model
    EmbeddingRequestHandler.runtime = args.runtime
    health_state = EmbeddingHealthState(
        model,
        runtime=args.runtime,
        probe_interval=args.probe_interval,
        start_worker=False,
    )
    EmbeddingRequestHandler.health_state = health_state
    server = ThreadingHTTPServer(('0.0.0.0', args.port), EmbeddingRequestHandler)
    health_state.start()
    sys.stderr.write(f'[EmbeddingServer] Listening on 0.0.0.0:{args.port}\n')
    sys.stderr.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write('[EmbeddingServer] Shutting down\n')
        sys.stderr.flush()
    finally:
        health_state.stop()
        server.server_close()


if __name__ == '__main__':
    main()
