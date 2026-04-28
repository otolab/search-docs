#!/usr/bin/env python3
"""
ONNX Runtime ベースの Embedding モデル
"""

import sys
import numpy as np
from typing import List, Union


BUCKET_SIZES = [64, 2048, 8192]


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
        self.model_path = model_path
        self.model_name = model_name
        self._dimension = dimension
        self.available = False
        self.session = None
        self.sessions = {}
        self.tokenizer = None
        self._use_buckets = False
        self._input_names = None

    def load(self) -> bool:
        try:
            import onnxruntime as ort
            from transformers import AutoTokenizer

            import os
            onnx_path = os.path.join(self.model_path, 'onnx', 'model.onnx')
            if not os.path.exists(onnx_path):
                onnx_path = os.path.join(self.model_path, 'model.onnx')

            self.tokenizer = AutoTokenizer.from_pretrained(self.model_path)

            available = ort.get_available_providers()

            if 'CoreMLExecutionProvider' in available:
                self._load_coreml_sessions(ort, onnx_path)
            elif 'CUDAExecutionProvider' in available:
                self._load_single_session(ort, onnx_path, ['CUDAExecutionProvider', 'CPUExecutionProvider'])
                device_info = "GPU (CUDA)"
                sys.stderr.write(f"ONNXEmbedding loaded: {self.model_name} ({self._dimension}d) on {device_info}\n")
            else:
                self._load_single_session(ort, onnx_path, ['CPUExecutionProvider'])
                device_info = "CPU"
                sys.stderr.write(f"ONNXEmbedding loaded: {self.model_name} ({self._dimension}d) on {device_info}\n")

            self.available = True
            return True
        except Exception as e:
            sys.stderr.write(f"ONNXEmbedding load failed: {e}\n")
            self.available = False
            return False

    def _load_coreml_sessions(self, ort, onnx_path: str):
        providers = [
            ('CoreMLExecutionProvider', {
                'ModelFormat': 'MLProgram',
                'MLComputeUnits': 'ALL',
                'AllowLowPrecisionAccumulationOnGPU': '1',
                'RequireStaticInputShapes': '1',
                'SpecializationStrategy': 'FastPrediction',
            }),
            'CPUExecutionProvider'
        ]

        for size in BUCKET_SIZES:
            so = ort.SessionOptions()
            so.add_free_dimension_override_by_name('batch_size', 1)
            so.add_free_dimension_override_by_name('sequence_length', size)
            self.sessions[size] = ort.InferenceSession(onnx_path, sess_options=so, providers=providers)

        first_session = self.sessions[BUCKET_SIZES[0]]
        self._input_names = [inp.name for inp in first_session.get_inputs()]
        self._use_buckets = True
        self.session = first_session

        sys.stderr.write(
            f"ONNXEmbedding loaded: {self.model_name} ({self._dimension}d) on CoreML GPU "
            f"(buckets: {BUCKET_SIZES})\n"
        )

    def _load_single_session(self, ort, onnx_path: str, providers):
        self.session = ort.InferenceSession(onnx_path, providers=providers)
        self._input_names = [inp.name for inp in self.session.get_inputs()]
        self._use_buckets = False

    @property
    def dimension(self) -> int:
        return self._dimension

    def _select_bucket(self, token_length: int) -> int:
        for size in BUCKET_SIZES:
            if token_length <= size:
                return size
        return BUCKET_SIZES[-1]

    def encode(self, text: Union[str, List[str]], dimension: int = None, batch_size: int = 128) -> Union[List[float], List[List[float]]]:
        if not self.available:
            raise RuntimeError("Model not loaded. Call load() first.")

        target_dim = dimension if dimension is not None else self._dimension
        is_single = isinstance(text, str)
        texts = [text] if is_single else text

        if self._use_buckets:
            all_embeddings = []
            for t in texts:
                vec = self._encode_single_bucketed(t)
                all_embeddings.append(vec)
            embeddings = np.stack(all_embeddings)
        else:
            embeddings = self._encode_batch(texts)

        # L2正規化
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.clip(norms, a_min=1e-9, a_max=None)
        embeddings = embeddings / norms

        adjusted = [self._adjust_dimensions(vec, target_dim) for vec in embeddings]
        result = [vec.tolist() for vec in adjusted]

        return result[0] if is_single else result

    def _encode_single_bucketed(self, text: str) -> np.ndarray:
        encoded = self.tokenizer(
            [text], padding=False, truncation=True, max_length=BUCKET_SIZES[-1], return_tensors='np'
        )
        token_length = encoded['input_ids'].shape[1]
        bucket = self._select_bucket(token_length)
        session = self.sessions[bucket]

        encoded = self.tokenizer(
            [text], padding='max_length', truncation=True, max_length=bucket, return_tensors='np'
        )
        input_ids = encoded['input_ids'].astype(np.int64)
        attention_mask = encoded['attention_mask'].astype(np.int64)

        ort_inputs = {'input_ids': input_ids, 'attention_mask': attention_mask}
        if 'token_type_ids' in self._input_names:
            ort_inputs['token_type_ids'] = np.zeros_like(input_ids)

        outputs = session.run(None, ort_inputs)
        last_hidden_state = outputs[0]

        # mean pooling
        mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
        sum_embeddings = np.sum(last_hidden_state * mask_expanded, axis=1)
        sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
        return (sum_embeddings / sum_mask)[0]

    def _encode_batch(self, texts: List[str]) -> np.ndarray:
        encoded = self.tokenizer(
            texts, padding=True, truncation=True, max_length=BUCKET_SIZES[-1], return_tensors='np'
        )
        input_ids = encoded['input_ids'].astype(np.int64)
        attention_mask = encoded['attention_mask'].astype(np.int64)

        ort_inputs = {'input_ids': input_ids, 'attention_mask': attention_mask}
        if 'token_type_ids' in self._input_names:
            ort_inputs['token_type_ids'] = np.zeros_like(input_ids)

        outputs = self.session.run(None, ort_inputs)
        last_hidden_state = outputs[0]

        mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
        sum_embeddings = np.sum(last_hidden_state * mask_expanded, axis=1)
        sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
        return sum_embeddings / sum_mask

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
