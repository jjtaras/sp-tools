// Unit tests for core/. Made-up values only; real job data lives in the fixture tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amount, durationHours, laborRate, laborCost } from '../core/index.mjs';

test('amount reads Innergy money objects', () => {
  assert.equal(amount({ Value: 12.5 }), 12.5);
  assert.equal(amount({ Value: 0 }), 0);
  assert.equal(amount({}), 0);
  assert.equal(amount(null), 0);
  assert.equal(amount(undefined), 0);
});

test('durationHours, default reading (counts seconds)', () => {
  assert.equal(durationHours('02:30:00'), 2.5);
  assert.equal(durationHours('00:00:36'), 0.01);
  assert.equal(durationHours('1.02:00:00'), 26);
  assert.equal(durationHours(''), 0);
  assert.equal(durationHours(null), 0);
  assert.ok(Number.isNaN(durationHours('02:30')));          // no seconds
  assert.ok(Number.isNaN(durationHours('n/a')));
});

test('durationHours, wholeMinutes reading (ignores seconds)', () => {
  const w = { wholeMinutes: true };
  assert.equal(durationHours('02:30:00', w), 2.5);
  assert.equal(durationHours('00:00:36', w), 0);
  assert.equal(durationHours('1.02:00:00', w), 26);
  assert.equal(durationHours('02:30', w), 2.5);
  assert.equal(durationHours('n/a', w), 0);
  assert.equal(durationHours('', w), 0);
});

test('labor rates and cost', () => {
  const rates = { drafting: 80, other: 40 };
  assert.equal(laborRate(true, rates), 80);
  assert.equal(laborRate(false, rates), 40);
  assert.equal(laborCost(2, 3, rates), 280);
  assert.equal(laborCost(0, 0, rates), 0);
});
