import { describe, expect, it } from 'vitest';
import { isGatewayUnavailableError } from '../lib/paymentGatewayDetection';

describe('isGatewayUnavailableError', () => {
  it('detects Daraja HTTP 400 as a gateway failure', () => {
    expect(isGatewayUnavailableError('Daraja request failed with status 400 (HTTP 400, raw: )')).toBe(true);
  });

  it('detects Safaricom timeout and connection errors', () => {
    expect(isGatewayUnavailableError('ETIMEDOUT while connecting to api.safaricom.co.ke')).toBe(true);
  });

  it('keeps ordinary validation errors as non-gateway failures', () => {
    expect(isGatewayUnavailableError('Amount must be at least KSH 1')).toBe(false);
  });
});
