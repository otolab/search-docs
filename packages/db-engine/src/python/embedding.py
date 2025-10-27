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

    def __init__(self, model_name: str = None):
        """
        初期化（モデルロードは常に遅延実行）

        Args:
            model_name: 使用するモデル名。Noneの場合はデフォルト
        """
        # モデル名を保存（後でinitialize()で使用）
        self.model_name = model_name or 'cl-nagoya/ruri-v3-30m'

        # モデル設定を取得
        if self.model_name not in self.MODEL_CONFIGS:
            sys.stderr.write(f"Warning: Unknown model {self.model_name}, using ruri-v3-30m\n")
            self.model_name = 'cl-nagoya/ruri-v3-30m'

        config = self.MODEL_CONFIGS[self.model_name]
        self._dimension = config['dimension']

        # モデルは未ロード状態で開始
        self.model = None
        self.available = False

    def initialize(self) -> bool:
        """
        モデルを実際にロード（明示的な初期化）

        Returns:
            初期化成功時True、失敗時False
        """
        if self.available:
            # 既に初期化済み
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

    @property
    def dimension(self) -> int:
        """モデルの出力次元数"""
        return self._dimension

    @property
    def is_loaded(self) -> bool:
        """モデルがロード済みかどうか"""
        return self.available

    def encode(self, text: str, dimension: int = None) -> List[float]:
        """
        テキストをベクトル化

        Args:
            text: ベクトル化するテキスト
            dimension: 出力次元数（Noneの場合はモデルのデフォルト）

        Returns:
            ベクトル表現
        """
        if dimension is None:
            dimension = self._dimension

        if not self.available:
            # モデルが利用できない場合はダミーベクトルを返す
            return [0.0] * dimension

        embeddings = self.model.encode(text)

        # 次元調整
        embeddings = self._adjust_dimension(embeddings, dimension)
        return embeddings.tolist()

    def _adjust_dimension(self, embeddings: np.ndarray, target_dim: int) -> np.ndarray:
        """
        ベクトルの次元を調整

        Args:
            embeddings: 元のベクトル
            target_dim: 目標次元数

        Returns:
            調整後のベクトル
        """
        current_dim = len(embeddings)

        if current_dim == target_dim:
            return embeddings

        elif current_dim > target_dim:
            # MRLを利用した次元削減
            embeddings = embeddings[:target_dim]
            # L2正規化
            norm = np.linalg.norm(embeddings)
            if norm > 0:
                embeddings = embeddings / norm

        else:
            # 次元が少ない場合はゼロパディング
            padding = [0.0] * (target_dim - current_dim)
            embeddings = np.concatenate([embeddings, padding])

        return embeddings

    @classmethod
    def get_available_models(cls) -> dict:
        """利用可能なモデルのリストを返す"""
        return cls.MODEL_CONFIGS.copy()


def create_embedding_model(model_name: str = None) -> EmbeddingModel:
    """
    埋め込みモデルのファクトリ関数

    Args:
        model_name: 使用するモデル名

    Returns:
        埋め込みモデルのインスタンス
    """
    return RuriEmbedding(model_name)
