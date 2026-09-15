import { normalize } from './text.ts';

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
