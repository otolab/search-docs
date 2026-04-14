#!/usr/bin/env python3
"""
Embedding Server - HTTP APIでEmbedding機能を提供
複数のMCPサーバからEmbeddingモデルを共有利用するためのサーバ

API:
  POST /encode  - テキストをベクトル化
  GET  /health  - ヘルスチェック（モデル情報を含む）
"""

import sys
import argparse
import json
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
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == '/encode':
            self._handle_encode()
        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_health(self):
        """ヘルスチェック - モデル情報を返す"""
        self._send_json(200, {
            "status": "ok",
            "model": self.model.model_name,
            "vectorDimension": self.model.dimension,
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
    parser.add_argument('--model', type=str, default='cl-nagoya/ruri-v3-30m', help='Embedding model name')
    args = parser.parse_args()

    # モデルをロード
    sys.stderr.write(f"[EmbeddingServer] Loading model: {args.model}\n")
    sys.stderr.flush()

    model = RuriEmbedding(model_name=args.model)
    if not model.load():
        sys.stderr.write("[EmbeddingServer] Failed to load model\n")
        sys.exit(1)

    sys.stderr.write(f"[EmbeddingServer] Model loaded: {args.model} ({model.dimension}d)\n")
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
