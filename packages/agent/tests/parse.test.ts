import { describe, it, expect } from 'vitest';
import { parseSearchAgentOutput } from '../src/parse.js';
import type { SearchAgentContext } from '../src/context.js';

function makeContext(chunks: Record<string, { documentPath: string; heading: string; content: string }>): SearchAgentContext {
  const result: SearchAgentContext = { query: 'test', chunks: {} };
  for (const [id, data] of Object.entries(chunks)) {
    result.chunks[id] = { id, ...data };
  }
  return result;
}

describe('parseSearchAgentOutput', () => {
  it('単一のDocumentタグをパースできる', () => {
    const context = makeContext({
      'sec-001': { documentPath: 'docs/arch.md', heading: 'Architecture', content: 'Full content here' },
    });
    const output = `<Document id={sec-001}>
  <Justification>This describes the system architecture.</Justification>
</Document>`;

    const docs = parseSearchAgentOutput(output, context);
    expect(docs).toHaveLength(1);
    expect(docs[0].sectionId).toBe('sec-001');
    expect(docs[0].documentPath).toBe('docs/arch.md');
    expect(docs[0].heading).toBe('Architecture');
    expect(docs[0].content).toBe('Full content here');
    expect(docs[0].justification).toBe('This describes the system architecture.');
  });

  it('複数のDocumentタグをパースできる', () => {
    const context = makeContext({
      'sec-001': { documentPath: 'docs/a.md', heading: 'A', content: 'Content A' },
      'sec-002': { documentPath: 'docs/b.md', heading: 'B', content: 'Content B' },
    });
    const output = `<Document id={sec-001}>
  <Justification>Reason A</Justification>
</Document>
<Document id={sec-002}>
  <Justification>Reason B</Justification>
</Document>`;

    const docs = parseSearchAgentOutput(output, context);
    expect(docs).toHaveLength(2);
    expect(docs[0].sectionId).toBe('sec-001');
    expect(docs[1].sectionId).toBe('sec-002');
  });

  it('contextにないチャンクIDでも空文字列でパースできる', () => {
    const context = makeContext({});
    const output = `<Document id={unknown-id}>
  <Justification>Some reason</Justification>
</Document>`;

    const docs = parseSearchAgentOutput(output, context);
    expect(docs).toHaveLength(1);
    expect(docs[0].sectionId).toBe('unknown-id');
    expect(docs[0].documentPath).toBe('');
    expect(docs[0].heading).toBe('');
  });

  it('Documentタグがない場合は空配列を返す', () => {
    const context = makeContext({});
    const output = 'No relevant documents found.';

    const docs = parseSearchAgentOutput(output, context);
    expect(docs).toHaveLength(0);
  });

  it('id=の波括弧なし形式もパースできる', () => {
    const context = makeContext({
      'sec-001': { documentPath: 'docs/a.md', heading: 'A', content: 'Content' },
    });
    const output = `<Document id=sec-001>
  <Justification>Reason</Justification>
</Document>`;

    const docs = parseSearchAgentOutput(output, context);
    expect(docs).toHaveLength(1);
    expect(docs[0].sectionId).toBe('sec-001');
  });
});
