/**
 * Splitter interfaces and exports
 */

import type { Section } from '@search-docs/types';

/**
 * Splitter interface
 */
export interface Splitter {
  split(content: string, documentPath: string, documentHash: string): Array<Omit<Section, 'vector'>>;
}

export { MarkdownSplitter } from './markdown-splitter.js';
export { TokenCounter } from './token-counter.js';
