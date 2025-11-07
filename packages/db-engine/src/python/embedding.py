#!/usr/bin/env python3
"""
日本語特化の埋め込みモデルを提供するモジュール
search-docs用にsebas-chanのRuriEmbeddingを利用
"""

import sys
from typing import List
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

            # モデルをロード
            self.model = SentenceTransformer(self.model_name)
            self.available = True
            sys.stderr.write(f"Ruri model loaded: {self.model_name} - {config['description']}\n")
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

    def encode(self, text: str, dimension: int = None) -> List[float]:
        """
        テキストをベクトル化

        Args:
            text: 変換対象のテキスト
            dimension: 出力次元数（Noneの場合はコンストラクタで指定した次元）

        Returns:
            ベクトル表現（floatのリスト）
        """
        if not self.available:
            raise RuntimeError("Model not loaded. Call load() first.")

        target_dim = dimension if dimension is not None else self._dimension

        try:
            # SentenceTransformerでエンコード
            embeddings = self.model.encode(text, convert_to_numpy=True)

            # 次元調整
            embeddings = self._adjust_dimensions(embeddings, target_dim)

            return embeddings.tolist()

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


def create_embedding_model(model_name: str) -> EmbeddingModel:
    """
    埋め込みモデルのファクトリー関数

    Args:
        model_name: モデル名

    Returns:
        EmbeddingModelインスタンス
    """
    # Ruriモデルの場合
    if model_name.startswith('cl-nagoya/ruri'):
        model = RuriEmbedding(model_name=model_name)
        model.load()
        return model
    else:
        raise ValueError(f"Unsupported model: {model_name}")
