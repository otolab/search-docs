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
  // モデル出力のバリエーションに対応:
  // 1. <Document id={id}><Justification>...</Justification></Document>  (理想形)
  // 2. <Document id=id>\n  <Justification>\n...\n</Document>            (閉じタグ省略)
  const pattern = /<Document\s+id=\{?([^}>]+)\}?>\s*<Justification>([\s\S]*?)(?:<\/Justification>\s*)?<\/Document>/g;

  // messagesのtool結果テキストからセクション情報を収集
  // フォーマット: [N] heading (documentPath, id=sectionId)\ncontent...
  const sectionMap = new Map<string, { documentPath: string; heading: string; content: string }>();
  if (context.messages) {
    const linePattern = /\[\d+\]\s+(.+?)\s+\((.+?),\s*document_id=([^)]+)\)\n([\s\S]*?)(?=\n\n\[\d+\]|$)/g;
    for (const msg of context.messages) {
      if ('role' in msg && msg.role === 'tool' && 'value' in msg) {
        const text = typeof msg.value === 'string' ? msg.value : String(msg.value);
        let m;
        while ((m = linePattern.exec(text)) !== null) {
          sectionMap.set(m[3].trim(), {
            heading: m[1].trim(),
            documentPath: m[2].trim(),
            content: m[4].trim(),
          });
        }
        linePattern.lastIndex = 0;
      }
    }
  }

  let match;
  while ((match = pattern.exec(output)) !== null) {
    const sectionId = match[1].trim();
    const justification = match[2].trim();
    const section = sectionMap.get(sectionId);
    const chunk = context.chunks?.[sectionId];

    documents.push({
      sectionId,
      documentPath: section?.documentPath ?? chunk?.documentPath ?? '',
      heading: section?.heading ?? chunk?.heading ?? '',
      content: section?.content ?? chunk?.content ?? '',
      justification,
    });
  }

  return documents;
}
