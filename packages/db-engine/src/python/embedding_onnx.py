#!/usr/bin/env python3
"""
ONNX Runtime ベースの Embedding モデル
"""

import sys
import numpy as np
from typing import List, Union


class ONNXEmbedding:
    """ONNX Runtime ベースの Embedding モデル"""

    MODEL_CONFIGS = {
        'ruri-v3-30m-onnx': {
            'dimension': 256,
            'hf_repo': 'sirasagi62/ruri-v3-30m-ONNX',
            'onnx_file': 'onnx/model.onnx',
            'description': 'Ruri v3 30M ONNX (256d)',
        }
    }

    def __init__(self, model_path: str, dimension: int = 256, model_name: str = 'ruri-v3-30m-onnx'):
        self.model_path = model_path  # ローカルディレクトリパス
        self.model_name = model_name
        self._dimension = dimension
        self.available = False
        self.session = None
        self.tokenizer = None

    def load(self) -> bool:
        try:
            import onnxruntime as ort
            from transformers import AutoTokenizer

            # GPU/CPU自動検出
            providers = ['CPUExecutionProvider']
            if 'CUDAExecutionProvider' in ort.get_available_providers():
                providers.insert(0, 'CUDAExecutionProvider')
                device_info = "GPU (CUDA)"
            else:
                device_info = "CPU"

            # ONNXモデルロード
            import os
            onnx_path = os.path.join(self.model_path, 'onnx', 'model.onnx')
            if not os.path.exists(onnx_path):
                # onnx/ サブディレクトリがない場合、直下を探す
                onnx_path = os.path.join(self.model_path, 'model.onnx')

            self.session = ort.InferenceSession(onnx_path, providers=providers)
            self.tokenizer = AutoTokenizer.from_pretrained(self.model_path)
            self.available = True

            sys.stderr.write(f"ONNXEmbedding loaded: {self.model_name} ({self._dimension}d) on {device_info}\n")
            return True
        except Exception as e:
            sys.stderr.write(f"ONNXEmbedding load failed: {e}\n")
            self.available = False
            return False

    @property
    def dimension(self) -> int:
        return self._dimension

    def encode(self, text: Union[str, List[str]], dimension: int = None, batch_size: int = 128) -> Union[List[float], List[List[float]]]:
        if not self.available:
            raise RuntimeError("Model not loaded. Call load() first.")

        target_dim = dimension if dimension is not None else self._dimension
        is_single = isinstance(text, str)
        texts = [text] if is_single else text

        # トークン化
        encoded = self.tokenizer(
            texts, padding=True, truncation=True, max_length=512, return_tensors='np'
        )

        # ONNX推論
        input_ids = encoded['input_ids'].astype(np.int64)
        attention_mask = encoded['attention_mask'].astype(np.int64)

        ort_inputs = {
            'input_ids': input_ids,
            'attention_mask': attention_mask,
        }
        # token_type_ids が必要なモデルの場合
        input_names = [inp.name for inp in self.session.get_inputs()]
        if 'token_type_ids' in input_names:
            ort_inputs['token_type_ids'] = np.zeros_like(input_ids)

        outputs = self.session.run(None, ort_inputs)
        # last_hidden_state (batch, seq_len, hidden_dim)
        last_hidden_state = outputs[0]

        # mean pooling (attention_mask考慮)
        mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
        sum_embeddings = np.sum(last_hidden_state * mask_expanded, axis=1)
        sum_mask = np.sum(mask_expanded, axis=1)
        sum_mask = np.clip(sum_mask, a_min=1e-9, a_max=None)
        embeddings = sum_embeddings / sum_mask

        # L2正規化
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.clip(norms, a_min=1e-9, a_max=None)
        embeddings = embeddings / norms

        # 次元調整
        adjusted = [self._adjust_dimensions(vec, target_dim) for vec in embeddings]
        result = [vec.tolist() for vec in adjusted]

        return result[0] if is_single else result

    def _adjust_dimensions(self, vector: np.ndarray, target_dim: int) -> np.ndarray:
        current_dim = len(vector)
        if current_dim == target_dim:
            return vector
        if current_dim > target_dim:
            vector = vector[:target_dim]
            norm = np.linalg.norm(vector)
            if norm > 0:
                vector = vector / norm
            return vector
        else:
            padded = np.zeros(target_dim, dtype=vector.dtype)
            padded[:current_dim] = vector
            return padded
