import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_DEPOSIT_AMOUNT, validateDepositAmount } from '@/lib/depositRules';

describe('deposit rules', () => {
  it('requires the stated minimum deposit amount', () => {
    expect(DEFAULT_MIN_DEPOSIT_AMOUNT).toBe(500);
    expect(validateDepositAmount(500)).toBe(true);
  });

  it('rejects amounts below the minimum deposit', () => {
    expect(validateDepositAmount(499)).toBe(false);
    expect(validateDepositAmount(0)).toBe(false);
    expect(validateDepositAmount(-1)).toBe(false);
    expect(validateDepositAmount(Number.NaN)).toBe(false);
  });
});
