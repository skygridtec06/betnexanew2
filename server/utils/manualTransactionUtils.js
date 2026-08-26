function normalizeManualTransactionStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'complete') return 'completed';
  if (normalized === 'failed' || normalized === 'rejected' || normalized === 'cancelled') return 'failed';
  if (normalized === 'pending' || normalized === 'processing') return 'pending';
  return 'pending';
}

function getManualBalanceDelta(type, status, amount) {
  const numericAmount = Number(amount) || 0;
  if (numericAmount <= 0) return 0;
  const normalizedType = String(type || '').trim().toLowerCase();
  const normalizedStatus = normalizeManualTransactionStatus(status);

  if (normalizedStatus !== 'completed') return 0;
  if (normalizedType === 'deposit') return numericAmount;
  if (normalizedType === 'withdrawal') return -numericAmount;
  return 0;
}

module.exports = {
  normalizeManualTransactionStatus,
  getManualBalanceDelta,
};
