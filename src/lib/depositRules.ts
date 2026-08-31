export const DEFAULT_MIN_DEPOSIT_AMOUNT = 500;

export function validateDepositAmount(amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  return amount >= DEFAULT_MIN_DEPOSIT_AMOUNT;
}
