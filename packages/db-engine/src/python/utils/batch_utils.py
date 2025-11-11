"""
バッチ処理ユーティリティ

トークン数を考慮してテキストを適切なバッチに分割する。
"""

from typing import List, Tuple, Generic, TypeVar
from .token_utils import estimate_tokens

T = TypeVar('T')


def create_token_aware_batches(
    texts: List[str],
    indices: List[T],
    max_tokens_per_batch: int = 8000
) -> List[Tuple[List[str], List[T]]]:
    """
    トークン量を考慮してバッチを分割

    各バッチのトークン数がmax_tokens_per_batchを超えないように
    テキストを複数のバッチに分割する。

    Args:
        texts: エンコードするテキストのリスト
        indices: 各テキストに対応するインデックス（任意の型）
        max_tokens_per_batch: 1バッチあたりの最大トークン数

    Returns:
        (texts, indices)のタプルのリスト

    Examples:
        >>> texts = ["a" * 200, "a" * 200, "a" * 200]  # 各50トークン
        >>> indices = [0, 1, 2]
        >>> batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)
        >>> len(batches)
        2
        >>> len(batches[0][0])  # 最初のバッチのテキスト数
        2
        >>> len(batches[1][0])  # 2番目のバッチのテキスト数
        1

    Notes:
        - 各バッチのトークン数はmax_tokens_per_batchを超えない
        - 1つのテキストがmax_tokens_per_batchを超える場合、そのテキスト単独で1バッチとなる
        - 空のリストを渡すと空のリストを返す
    """
    if not texts:
        return []

    if len(texts) != len(indices):
        raise ValueError(f"texts and indices must have the same length: {len(texts)} != {len(indices)}")

    batches = []
    current_batch_texts = []
    current_batch_indices = []
    current_tokens = 0

    for text, idx in zip(texts, indices):
        # トークン数を推定
        estimated_tokens = estimate_tokens(text)

        # バッチが大きくなりすぎたら分割
        if current_tokens + estimated_tokens > max_tokens_per_batch and current_batch_texts:
            batches.append((current_batch_texts, current_batch_indices))
            current_batch_texts = [text]
            current_batch_indices = [idx]
            current_tokens = estimated_tokens
        else:
            current_batch_texts.append(text)
            current_batch_indices.append(idx)
            current_tokens += estimated_tokens

    # 最後のバッチを追加
    if current_batch_texts:
        batches.append((current_batch_texts, current_batch_indices))

    return batches


def get_batch_stats(batches: List[Tuple[List[str], List[T]]]) -> dict:
    """
    バッチの統計情報を取得

    Args:
        batches: create_token_aware_batches()の戻り値

    Returns:
        統計情報の辞書
        {
            'num_batches': バッチ数,
            'total_texts': 全テキスト数,
            'batches_info': 各バッチの情報のリスト
        }

    Examples:
        >>> texts = ["a" * 200, "a" * 200, "a" * 200]
        >>> indices = [0, 1, 2]
        >>> batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)
        >>> stats = get_batch_stats(batches)
        >>> stats['num_batches']
        2
        >>> stats['total_texts']
        3
    """
    from .token_utils import estimate_total_tokens

    batches_info = []
    total_texts = 0

    for i, (batch_texts, batch_indices) in enumerate(batches):
        batch_tokens = estimate_total_tokens(batch_texts)
        batches_info.append({
            'batch_num': i + 1,
            'num_texts': len(batch_texts),
            'estimated_tokens': batch_tokens
        })
        total_texts += len(batch_texts)

    return {
        'num_batches': len(batches),
        'total_texts': total_texts,
        'batches_info': batches_info
    }
