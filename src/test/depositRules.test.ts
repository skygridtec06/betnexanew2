import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_DEPOSIT_AMOUNT, validateDepositAmount } from '@/lib/depositRules';

describe('deposit rules', () => {
  it('allows small deposits such as KES 3', () => {
    expect(DEFAULT_MIN_DEPOSIT_AMOUNT).toBe(1);
    expect(validateDepositAmount(3)).toBe(true);
  });

  it('rejects invalid non-positive amounts', () => {
    expect(validateDepositAmount(0)).toBe(false);
    expect(validateDepositAmount(-1)).toBe(false);
    expect(validateDepositAmount(Number.NaN)).toBe(false);
  });
});
