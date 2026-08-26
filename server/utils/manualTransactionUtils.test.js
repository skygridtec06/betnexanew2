const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeManualTransactionStatus,
  getManualBalanceDelta,
} = require('./manualTransactionUtils.js');

test('normalizeManualTransactionStatus accepts valid statuses', () => {
  assert.equal(normalizeManualTransactionStatus('completed'), 'completed');
  assert.equal(normalizeManualTransactionStatus('FAILED'), 'failed');
  assert.equal(normalizeManualTransactionStatus('Pending'), 'pending');
});

test('getManualBalanceDelta applies account adjustments correctly', () => {
  assert.equal(getManualBalanceDelta('deposit', 'completed', 2500), 2500);
  assert.equal(getManualBalanceDelta('withdrawal', 'completed', 1500), -1500);
  assert.equal(getManualBalanceDelta('deposit', 'failed', 2500), 0);
  assert.equal(getManualBalanceDelta('withdrawal', 'pending', 1500), 0);
});
