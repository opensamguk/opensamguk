import { expect, it } from 'vitest';
import { transactionFailure } from './readTransaction';

it('classifies P2028 without exposing the original message or misclassifying other closed transactions', () => {
  const error = (message: string, meta?: object) => Object.assign(new Error(message), { code: 'P2028', meta });
  expect(transactionFailure(error('Unable to start a transaction in the given time. private-value'))).toBe('maxWait');
  expect(
    transactionFailure(error('private-value', { error: 'A commit cannot be executed on an expired transaction.' })),
  ).toBe('timeout');
  expect(transactionFailure(error('Transaction already closed: rolled back private-value'))).toBe('other');
  expect(transactionFailure(new Error('expired transaction'))).toBeUndefined();
  expect(transactionFailure(null)).toBeUndefined();
});
