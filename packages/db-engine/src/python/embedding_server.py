#!/usr/bin/env python3
"""
Embedding Server - HTTP APIでEmbedding機能を提供
複数のMCPサーバからEmbeddingモデルを共有利用するためのサーバ

API:
  POST /encode      - テキストをベクトル化
  POST /api/embed   - Ollama API互換のEmbedding
  GET  /health      - ヘルスチェック（モデル情報を含む）
"""

import sys
import argparse
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import List

from embedding import RuriEmbedding


class EmbeddingRequestHandler(BaseHTTPRequestHandler):
    """Embedding Server の HTTPリクエストハンドラ"""

    # クラス変数としてモデルを保持
    model: RuriEmbedding = None  # type: ignore

    def do_GET(self):
        if self.path == '/health':
            self._handle_health()
        elif self.path == '/api/tags':
            self._handle_tags()
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == '/encode':
            self._handle_encode()
        elif self.path == '/api/embed':
            self._handle_ollama_embed()
        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_health(self):
        """ヘルスチェック - モデル情報を返す"""
        self._send_json(200, {
            "status": "ok",
            "model": self.model.model_name,
            "vectorDimension": self.model.dimension,
        })

    def _handle_tags(self):
        """Ollama互換 /api/tags - 利用可能なモデル一覧"""
        self._send_json(200, {
            "models": [{
                "name": self.model.model_name,
                "model": self.model.model_name,
                "details": {
                    "family": "embedding",
                    "parameter_size": "30M",
                },
            }],
        })

    def _handle_encode(self):
        """テキストをベクトル化"""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8'))

            texts: List[str] = data.get('texts', [])
            dimension: int = data.get('dimension', self.model.dimension)

            if not texts:
                self._send_json(400, {"error": "texts is required and must be non-empty"})
                return

            # バッチエンコード
            vectors = self.model.encode(texts, dimension=dimension)

            # encode()は単一文字列の場合List[float]を返すが、
            # ここでは常にリストで渡しているのでList[List[float]]が返る
            self._send_json(200, {"vectors": vectors})

        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
        except Exception as e:
            sys.stderr.write(f"[EmbeddingServer] Error in /encode: {e}\n")
            sys.stderr.flush()
            self._send_json(500, {"error": str(e)})

    def _handle_ollama_embed(self):
        """Ollama API互換のEmbedding (/api/embed)"""
        try:
            start_time = time.time()
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8'))

            # Ollama API形式: {"model": "ruri", "input": "text" | ["text1", "text2"], "dimensions": 256, "truncate": true}
            input_data = data.get('input')
            if input_data is None:
                self._send_json(400, {"error": "input is required"})
                return

            # input は文字列または文字列のリスト
            if isinstance(input_data, str):
                texts = [input_data]
            elif isinstance(input_data, list):
                texts = input_data
            else:
                self._send_json(400, {"error": "input must be a string or array of strings"})
                return

            dimension = data.get('dimensions', self.model.dimension)

            # バッチエンコード
            vectors = self.model.encode(texts, dimension=dimension)

            # vectors は List[List[float]] 形式
            end_time = time.time()
            duration_ns = int((end_time - start_time) * 1e9)

            # Ollama API形式のレスポンス
            response = {
                "model": self.model.model_name,
                "embeddings": vectors,
                "total_duration": duration_ns,
                "load_duration": 0,
                "prompt_eval_count": len(texts),
            }

            self._send_json(200, response)

        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
        except Exception as e:
            sys.stderr.write(f"[EmbeddingServer] Error in /api/embed: {e}\n")
            sys.stderr.flush()
            self._send_json(500, {"error": str(e)})

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
        sys.stderr.write(f"[EmbeddingServer] {args[0]} {args[1]} {args[2]}\n")
        sys.stderr.flush()


def main():
    parser = argparse.ArgumentParser(description='search-docs Embedding Server')
    parser.add_argument('--port', type=int, default=8080, help='Listen port (default: 8080)')
    parser.add_argument('--model', type=str, default='cl-nagoya/ruri-v3-30m', help='Embedding model name (torch)')
    parser.add_argument('--runtime', type=str, choices=['onnx', 'torch'], default='onnx', help='Runtime (default: onnx)')
    parser.add_argument('--model-path', type=str, default=None, help='ONNX model path')
    parser.add_argument('--dimension', type=int, default=256, help='Vector dimension (default: 256)')
    args = parser.parse_args()

    # モデルをロード
    if args.runtime == 'onnx':
        from embedding_onnx import ONNXEmbedding
        model_path = args.model_path or '/app/.cache/models/ruri-v3-30m-onnx'
        sys.stderr.write(f"[EmbeddingServer] Loading ONNX model from: {model_path}\n")
        sys.stderr.flush()
        model = ONNXEmbedding(model_path=model_path, dimension=args.dimension)
    else:
        sys.stderr.write(f"[EmbeddingServer] Loading torch model: {args.model}\n")
        sys.stderr.flush()
        model = RuriEmbedding(model_name=args.model)

    if not model.load():
        sys.stderr.write("[EmbeddingServer] Failed to load model\n")
        sys.exit(1)

    sys.stderr.write(f"[EmbeddingServer] Model loaded: {model.model_name} ({model.dimension}d)\n")
    sys.stderr.flush()

    # ハンドラにモデルを設定
    EmbeddingRequestHandler.model = model

    # サーバ起動
    server = HTTPServer(('0.0.0.0', args.port), EmbeddingRequestHandler)
    sys.stderr.write(f"[EmbeddingServer] Listening on 0.0.0.0:{args.port}\n")
    sys.stderr.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("[EmbeddingServer] Shutting down\n")
        sys.stderr.flush()
        server.shutdown()


if __name__ == '__main__':
    main()
