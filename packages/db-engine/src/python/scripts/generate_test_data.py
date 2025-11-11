#!/usr/bin/env python3
"""
task23用のテストデータ生成スクリプト

3つのパターンでテストデータを生成：
- Pattern A: 多数の小さなファイル（100個、各500-1000トークン）
- Pattern B: 大きな少数のファイル（5個、各5000-10000トークン、一部7500超）
- Pattern C: 組み合わせ（50個の小 + 5個の大）
"""

import argparse
import random
import shutil
from pathlib import Path
from typing import List, Tuple


def generate_paragraph(min_tokens: int, max_tokens: int) -> str:
    """指定トークン数の段落を生成

    Args:
        min_tokens: 最小トークン数
        max_tokens: 最大トークン数

    Returns:
        生成された段落テキスト
    """
    # トークン数を決定（文字数 = トークン数 * 4）
    target_tokens = random.randint(min_tokens, max_tokens)
    target_chars = target_tokens * 4

    # ダミーテキスト生成（Lorem ipsum風）
    words = [
        "Lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
        "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
        "et", "dolore", "magna", "aliqua", "Ut", "enim", "ad", "minim", "veniam",
        "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi", "ut",
        "aliquip", "ex", "ea", "commodo", "consequat", "Duis", "aute", "irure"
    ]

    paragraph = []
    current_length = 0

    while current_length < target_chars:
        word = random.choice(words)
        paragraph.append(word)
        current_length += len(word) + 1  # +1 for space

    return " ".join(paragraph)


def generate_small_file(filepath: Path, file_index: int):
    """小さなファイルを生成（500-1000トークン）

    Args:
        filepath: 出力ファイルパス
        file_index: ファイル番号（タイトルに使用）
    """
    content = f"# Document {file_index:03d}\n\n"

    # 3-5個のセクション
    num_sections = random.randint(3, 5)

    for i in range(num_sections):
        section_title = f"Section {i+1}"
        # 各セクション100-200トークン（400-800文字）
        section_content = generate_paragraph(100, 200)

        content += f"## {section_title}\n\n{section_content}\n\n"

    filepath.write_text(content, encoding='utf-8')


def generate_large_file(filepath: Path, file_index: int, include_oversized: bool = False):
    """大きなファイルを生成（5000-10000トークン）

    Args:
        filepath: 出力ファイルパス
        file_index: ファイル番号
        include_oversized: 7500トークンを超えるセクションを含めるか
    """
    content = f"# Large Document {file_index:03d}\n\n"

    # 5-8個のセクション
    num_sections = random.randint(5, 8)

    for i in range(num_sections):
        section_title = f"Section {i+1}"

        # 一部のセクションを意図的に大きくする
        if include_oversized and i == 2:  # 3番目のセクションを大きくする
            # 10000トークン（40000文字）のセクション - 7500トークンを確実に超える
            section_content = generate_paragraph(10000, 11000)
            content += f"## {section_title} (Oversized)\n\n{section_content}\n\n"
        else:
            # 通常サイズ（800-1500トークン）
            section_content = generate_paragraph(800, 1500)
            content += f"## {section_title}\n\n{section_content}\n\n"

    filepath.write_text(content, encoding='utf-8')


def generate_pattern_a(output_dir: Path):
    """Pattern A: 多数の小さなファイル（100個）

    Args:
        output_dir: 出力ディレクトリ
    """
    print(f"Generating Pattern A: Many-Small (100 files)...")
    output_dir.mkdir(parents=True, exist_ok=True)

    for i in range(100):
        filepath = output_dir / f"small_{i:03d}.md"
        generate_small_file(filepath, i)
        if (i + 1) % 20 == 0:
            print(f"  Generated {i + 1}/100 files")

    print(f"✓ Pattern A complete: {output_dir}")


def generate_pattern_b(output_dir: Path):
    """Pattern B: 大きな少数のファイル（5個、一部7500超）

    Args:
        output_dir: 出力ディレクトリ
    """
    print(f"Generating Pattern B: Few-Large (5 files)...")
    output_dir.mkdir(parents=True, exist_ok=True)

    for i in range(5):
        filepath = output_dir / f"large_{i:03d}.md"
        # 最初の2つのファイルに超過セクションを含める
        include_oversized = (i < 2)
        generate_large_file(filepath, i, include_oversized=include_oversized)
        print(f"  Generated {i + 1}/5 files (oversized={include_oversized})")

    print(f"✓ Pattern B complete: {output_dir}")


def generate_pattern_c(output_dir: Path):
    """Pattern C: 組み合わせ（50小 + 5大）

    Args:
        output_dir: 出力ディレクトリ
    """
    print(f"Generating Pattern C: Mixed (50 small + 5 large)...")
    output_dir.mkdir(parents=True, exist_ok=True)

    # 50個の小ファイル
    for i in range(50):
        filepath = output_dir / f"small_{i:03d}.md"
        generate_small_file(filepath, i)
        if (i + 1) % 10 == 0:
            print(f"  Generated {i + 1}/50 small files")

    # 5個の大ファイル
    for i in range(5):
        filepath = output_dir / f"large_{i:03d}.md"
        include_oversized = (i < 2)
        generate_large_file(filepath, i, include_oversized=include_oversized)
        print(f"  Generated {i + 1}/5 large files (oversized={include_oversized})")

    print(f"✓ Pattern C complete: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Generate test data for task23")
    parser.add_argument(
        "pattern",
        choices=["a", "b", "c", "all"],
        help="Test pattern to generate (a=many-small, b=few-large, c=mixed, all=all patterns)"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/private/tmp/task23-test-data"),
        help="Output directory (default: /private/tmp/task23-test-data)"
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Clean output directory before generating"
    )

    args = parser.parse_args()

    # Clean if requested
    if args.clean and args.output_dir.exists():
        print(f"Cleaning {args.output_dir}...")
        shutil.rmtree(args.output_dir)

    # Generate patterns
    if args.pattern in ["a", "all"]:
        generate_pattern_a(args.output_dir / "pattern-a")

    if args.pattern in ["b", "all"]:
        generate_pattern_b(args.output_dir / "pattern-b")

    if args.pattern in ["c", "all"]:
        generate_pattern_c(args.output_dir / "pattern-c")

    print("\n✓ All patterns generated successfully!")
    print(f"Test data location: {args.output_dir}")


if __name__ == "__main__":
    main()
