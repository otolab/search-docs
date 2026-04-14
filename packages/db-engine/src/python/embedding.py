#!/usr/bin/env python3
"""
日本語特化の埋め込みモデルを提供するモジュール
search-docs用にsebas-chanのRuriEmbeddingを利用
"""

import sys
import json
import urllib.request
import urllib.error
from typing import List, Union
import numpy as np


class EmbeddingModel:
    """Embedding model base class"""
    def encode(self, text: str, dimension: int = None) -> List[float]:
        raise NotImplementedError

    @property
    def dimension(self) -> int:
        """モデルの出力次元数"""
        raise NotImplementedError


class RuriEmbedding(EmbeddingModel):
    """Japanese-optimized Ruri model with configurable variants"""

    # サポートされるモデルの設定
    MODEL_CONFIGS = {
        'cl-nagoya/ruri-v3-310m': {
            'dimension': 768,
            'description': 'Large model (1.2GB, 768d)',
            'memory': '~1.2GB'
        },
        'cl-nagoya/ruri-v3-30m': {
            'dimension': 256,
            'description': 'Small model (120MB, 256d)',
            'memory': '~120MB'
        }
    }

    def __init__(self, model_name: str = 'cl-nagoya/ruri-v3-30m', dimension: int = None):
        """
        Initialize Ruri embedding model

        Args:
            model_name: モデル名（デフォルト: 'cl-nagoya/ruri-v3-30m'）
            dimension: 出力次元数（Noneの場合はモデルのデフォルト次元）
        """
        self.model_name = model_name
        self.available = False
        self.model = None
        self.device = None

        if model_name not in self.MODEL_CONFIGS:
            raise ValueError(
                f"Unsupported model: {model_name}. "
                f"Supported models: {list(self.MODEL_CONFIGS.keys())}"
            )

        config = self.MODEL_CONFIGS[model_name]
        self._dimension = dimension if dimension is not None else config['dimension']
        self.model_dimension = config['dimension']

        # 遅延ロード: load() を呼ぶまでモデルをロードしない
        sys.stderr.write(f"RuriEmbedding initialized: {model_name} ({config['description']})\n")

    def load(self) -> bool:
        """モデルを実際にロード"""
        if self.available:
            return True

        try:
            from sentence_transformers import SentenceTransformer

            config = self.MODEL_CONFIGS[self.model_name]

            # GPU/CPU自動検出
            try:
                import torch
                if torch.cuda.is_available():
                    self.device = 'cuda'
                    device_info = f"GPU ({torch.cuda.get_device_name(0)})"
                elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                    self.device = 'mps'
                    device_info = "GPU (Apple Silicon MPS)"
                else:
                    self.device = 'cpu'
                    device_info = "CPU"
            except ImportError:
                self.device = 'cpu'
                device_info = "CPU (torch not available)"

            # モデルをロード（deviceを指定）
            self.model = SentenceTransformer(self.model_name, device=self.device)
            self.available = True
            sys.stderr.write(
                f"Ruri model loaded: {self.model_name} - {config['description']} on {device_info}\n"
            )
            return True

        except (ImportError, Exception) as e:
            sys.stderr.write(f"Warning: Could not load Ruri model: {e}\n")
            self.available = False
            self.model = None
            return False

    def initialize(self) -> bool:
        """モデルを初期化（loadのエイリアス）"""
        return self.load()

    @property
    def dimension(self) -> int:
        """モデルの出力次元数"""
        return self._dimension

    def encode(
        self,
        text: Union[str, List[str]],
        dimension: int = None,
        batch_size: int = 128
    ) -> Union[List[float], List[List[float]]]:
        """
        テキストをベクトル化（バッチ処理対応）

        Args:
            text: 変換対象のテキスト（単一文字列またはリスト）
            dimension: 出力次元数（Noneの場合はコンストラクタで指定した次元）
            batch_size: バッチサイズ（デフォルト: 32）

        Returns:
            ベクトル表現（floatのリストまたはリストのリスト）
            - 入力が単一文字列の場合: List[float]
            - 入力がリストの場合: List[List[float]]
        """
        if not self.available:
            raise RuntimeError("Model not loaded. Call load() first.")

        target_dim = dimension if dimension is not None else self._dimension
        is_single = isinstance(text, str)

        try:
            # 単一文字列の場合はリストに変換
            texts = [text] if is_single else text

            # SentenceTransformerでバッチエンコード
            embeddings = self.model.encode(
                texts,
                convert_to_numpy=True,
                batch_size=batch_size,
                show_progress_bar=False
            )

            # 各ベクトルの次元を調整
            adjusted = [self._adjust_dimensions(vec, target_dim) for vec in embeddings]

            # リストに変換
            result = [vec.tolist() for vec in adjusted]

            # 単一入力の場合は単一の結果を返す（後方互換性）
            return result[0] if is_single else result

        except Exception as e:
            sys.stderr.write(f"Error encoding text: {e}\n")
            raise

    def _adjust_dimensions(self, vector: np.ndarray, target_dim: int) -> np.ndarray:
        """
        ベクトルの次元を調整

        Args:
            vector: 入力ベクトル
            target_dim: 目標次元数

        Returns:
            調整されたベクトル
        """
        current_dim = len(vector)

        if current_dim == target_dim:
            return vector

        if current_dim > target_dim:
            # 高次元 → 低次元: 切り詰めてL2正規化
            vector = vector[:target_dim]
            norm = np.linalg.norm(vector)
            if norm > 0:
                vector = vector / norm
            return vector
        else:
            # 低次元 → 高次元: ゼロパディング
            padded = np.zeros(target_dim, dtype=vector.dtype)
            padded[:current_dim] = vector
            return padded


class RemoteEmbeddingModel(EmbeddingModel):
    """HTTP経由でEmbeddingサーバに接続するモデル"""

    def __init__(self, url: str, vector_dimension: int = 256):
        """
        Args:
            url: EmbeddingサーバのベースURL（例: http://localhost:8080）
            vector_dimension: ベクトル次元数
        """
        self.url = url.rstrip('/')
        self._dimension = vector_dimension
        self.model_name = "remote"
        self.available = True
        sys.stderr.write(f"RemoteEmbeddingModel initialized: {self.url}\n")

    def load(self) -> bool:
        """リモートモデルはロード不要"""
        return True

    def initialize(self) -> bool:
        """リモートモデルは初期化不要"""
        return True

    @property
    def dimension(self) -> int:
        return self._dimension

    def encode(
        self,
        text: Union[str, List[str]],
        dimension: int = None,
        batch_size: int = 128
    ) -> Union[List[float], List[List[float]]]:
        """HTTP経由でテキストをベクトル化"""
        target_dim = dimension if dimension is not None else self._dimension
        is_single = isinstance(text, str)
        texts = [text] if is_single else text

        try:
            request_data = json.dumps({
                "texts": texts,
                "dimension": target_dim,
            }).encode('utf-8')

            req = urllib.request.Request(
                f"{self.url}/encode",
                data=request_data,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )

            with urllib.request.urlopen(req, timeout=60) as response:
                result = json.loads(response.read().decode('utf-8'))
                vectors = result['vectors']
                return vectors[0] if is_single else vectors

        except Exception as e:
            sys.stderr.write(f"RemoteEmbeddingModel encode error: {e}\n")
            raise


def create_embedding_model(embedding_url: str, vector_dimension: int) -> EmbeddingModel:
    """
    埋め込みモデルのファクトリー関数（HTTP経由のみ）

    Embedding Serverは事前起動が必要です。

    Args:
        embedding_url: EmbeddingサーバのベースURL（例: http://localhost:8080）
        vector_dimension: ベクトル次元数

    Returns:
        RemoteEmbeddingModelインスタンス
    """
    return RemoteEmbeddingModel(url=embedding_url, vector_dimension=vector_dimension)
