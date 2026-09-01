export const DEFAULT_MIN_DEPOSIT_AMOUNT = 1;

export function validateDepositAmount(amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  return amount > 0;
}
