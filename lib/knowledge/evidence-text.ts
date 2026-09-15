import { normalize } from './text.ts';

// 回答モデルへ渡す1件あたりの根拠本文の上限。長い根拠は生成と校閲の時間を膨らませる。
export const EVIDENCE_CONTENT_LIMIT = 900;

/**
 * 上限を超える根拠は、段落、次に文の切れ目までで切る。
 * 文の途中で切ると、モデルが引用できる範囲と読める範囲がずれるため、区切りを優先する。
 * 切れ目が浅すぎて根拠として使えない場合は、上限どおりの位置で切る。
 */
export function truncateEvidence(content: string, limit: number = EVIDENCE_CONTENT_LIMIT): string {
  if (Array.from(content).length <= limit) return content;
  const head = Array.from(content).slice(0, limit).join('');
  const floor = Math.floor(limit / 2);
  const paragraph = head.lastIndexOf('\n\n');
  if (paragraph >= floor) return head.slice(0, paragraph).trimEnd();
  const sentence = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('. ')
  );
  if (sentence >= floor) return head.slice(0, sentence + 1).trimEnd();
  return head.trimEnd();
}

export interface Evidence {
  content: string;
  excludedStatements?: string[];
}

/**
 * Returns evidence content with whole paragraphs removed when they contain
 * an excluded statement. Matching is done on normalized paragraph text.
 *
 * If an excluded statement spans multiple paragraphs (contains a blank line),
 * the entire content is returned as an empty string, because a safe partial
 * removal cannot be guaranteed.
 */
export function visibleEvidenceContent(evidence: Evidence): string {
  const { content, excludedStatements } = evidence;

  if (!excludedStatements || excludedStatements.length === 0) {
    return content;
  }

  const normalizedExcluded = excludedStatements
    .map((statement) => normalize(statement))
    .filter((s) => s.length > 0);

  if (normalizedExcluded.length === 0) {
    return content;
  }

  for (const statement of normalizedExcluded) {
    if (/\n\s*\n/.test(statement)) {
      return '';
    }
  }

  const paragraphs = content.split(/\n\s*\n/);
  const keptParagraphs: string[] = [];

  for (const paragraph of paragraphs) {
    const normalizedParagraph = normalize(paragraph);
    const shouldRemove = normalizedExcluded.some((statement) =>
      normalizedParagraph.includes(statement)
    );

    if (!shouldRemove) {
      keptParagraphs.push(paragraph);
    }
  }

  return keptParagraphs.join('\n\n');
}
