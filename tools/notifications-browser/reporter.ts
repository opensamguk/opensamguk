import { readFile } from 'node:fs/promises';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { RECEIPT_PATH, TRIAL_CONTENT } from './fixture';

export default class NotificationReporter implements Reporter {
  private results: { id: string; passed: boolean }[] = [];
  constructor(private options: { receiptPath?: string } = {}) {}
  onTestEnd(test: Pick<TestCase, 'id' | 'expectedStatus'>, result: Pick<TestResult, 'status' | 'retry'>) {
    this.results.push({
      id: test.id,
      passed: test.expectedStatus === 'passed' && result.status === 'passed' && result.retry === 0,
    });
  }
  async onEnd(result: Pick<FullResult, 'status'>): Promise<{ status: FullResult['status'] }> {
    let valid = false;
    try {
      const receipt: unknown = JSON.parse(await readFile(this.options.receiptPath ?? RECEIPT_PATH, 'utf8'));
      valid =
        JSON.stringify(receipt) ===
        JSON.stringify({ requests: 1, valid: 1, invalid: 0, method: 'POST', content: TRIAL_CONTENT });
    } catch {
      /* 수신 증거가 없으면 통과시키지 않는다. */
    }
    const passed =
      result.status === 'passed' &&
      this.results.length === 2 &&
      new Set(this.results.map((item) => item.id)).size === 2 &&
      this.results.every((item) => item.passed) &&
      valid;
    console.log(
      passed
        ? '알림 Chromium 2건 통과, skip·retry 0, 시험 POST 1건 확인.'
        : '알림 Chromium 두 건과 수신 증거 검증에 실패했습니다.',
    );
    return { status: passed ? 'passed' : 'failed' };
  }
}
