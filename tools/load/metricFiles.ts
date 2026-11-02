import { readFile } from 'node:fs/promises';
import { commitMetricSchema, type LoadCommitMetric } from './report';

export function parseCommitMetrics(text: string): LoadCommitMetric[] {
  if (!text.length || !text.endsWith('\n') || Buffer.byteLength(text, 'utf8') > 64 * 1024 * 1024)
    throw new Error('LOAD_METRIC_FILE_INCOMPLETE_OR_TOO_LARGE');
  const metrics: LoadCommitMetric[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error('LOAD_METRIC_JSONL_INVALID');
    }
    const parsed = commitMetricSchema.safeParse(raw);
    if (!parsed.success) throw new Error('LOAD_METRIC_DTO_INVALID');
    // invalid 표본과 중복도 그대로 남겨 report에서 실패시킨다.
    metrics.push(parsed.data);
  }
  return metrics;
}

export async function readCommitMetrics(file: string): Promise<LoadCommitMetric[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error('LOAD_METRIC_FILE_UNREADABLE');
  }
  return parseCommitMetrics(text);
}
