import type { RetrievedDocument, SearchAgentContext } from './context.js';

/**
 * モデルの最終出力からRetrievedDocument[]をパースする
 *
 * 期待フォーマット:
 * <Document id={sectionId}>
 *   <Justification>...</Justification>
 * </Document>
 */
export function parseSearchAgentOutput(
  output: string,
  context: SearchAgentContext,
): RetrievedDocument[] {
  const documents: RetrievedDocument[] = [];
  const pattern = /<Document\s+id=\{?([^}>]+)\}?>\s*<Justification>([\s\S]*?)<\/Justification>\s*<\/Document>/g;

  let match;
  while ((match = pattern.exec(output)) !== null) {
    const sectionId = match[1].trim();
    const justification = match[2].trim();
    const chunk = context.chunks[sectionId];

    documents.push({
      sectionId,
      documentPath: chunk?.documentPath ?? '',
      heading: chunk?.heading ?? '',
      content: chunk?.content ?? '',
      justification,
    });
  }

  return documents;
}
