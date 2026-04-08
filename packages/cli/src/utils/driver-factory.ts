/**
 * AIドライバのファクトリ
 */
import type { AIDriver, FormatterOptions } from '@modular-prompt/driver';

export type DriverType = 'mlx' | 'anthropic' | 'openai' | 'ollama' | 'google';

export interface CreateDriverOptions {
  type: DriverType;
  model?: string;
  formatterOptions?: FormatterOptions;
}

/**
 * 指定されたドライバタイプに応じたAIDriverを生成する
 *
 * ドライバモジュールは動的インポートで遅延ロードする。
 */
export async function createDriver(options: CreateDriverOptions): Promise<AIDriver> {
  const { type, model } = options;

  switch (type) {
    case 'mlx': {
      if (!model) {
        throw new Error('MlxDriver には --model が必須です (例: mlx-community/context-1-MLX-4bit)');
      }
      const { MlxDriver } = await import('@modular-prompt/driver');
      return new MlxDriver({ model, formatterOptions: options.formatterOptions, defaultOptions: { temperature: 0.3 } });
    }

    case 'anthropic': {
      const { AnthropicDriver } = await import('@modular-prompt/driver');
      return new AnthropicDriver({
        model: model ?? 'claude-sonnet-4-20250514',
      });
    }

    case 'openai': {
      const { OpenAIDriver } = await import('@modular-prompt/driver');
      return new OpenAIDriver({
        model: model ?? 'gpt-4o',
      });
    }

    case 'ollama': {
      const { OllamaDriver } = await import('@modular-prompt/driver');
      return new OllamaDriver({
        model: model ?? 'llama3.1',
      });
    }

    case 'google': {
      const { GoogleGenAIDriver } = await import('@modular-prompt/driver');
      return new GoogleGenAIDriver({
        model: model ?? 'gemini-2.0-flash',
      });
    }

    default:
      throw new Error(`未対応のドライバタイプ: ${type}`);
  }
}
