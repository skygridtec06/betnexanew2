export function isGatewayUnavailableError(message?: string | null): boolean {
  if (!message) return false;

  const normalized = String(message).trim();

  if (!normalized) return false;

  return /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|timed out|connect .*443|Daraja .*failed|Daraja request failed with status \d+|HTTP 400|HTTP 401|HTTP 403|api\.safaricom\.co\.ke|M-Pesa STK .* unavailable|temporarily unavailable|Paybill deposit option)/i.test(normalized);
}
