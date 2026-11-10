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

test('durationHours reads to the whole minute (seconds dropped)', () => {
  assert.equal(durationHours('02:30:00'), 2.5);
  assert.equal(durationHours('02:30:59'), 2.5);
  assert.equal(durationHours('00:00:36'), 0);
  assert.equal(durationHours('1.02:00:00'), 26);
  assert.equal(durationHours('02:30'), 2.5);
  assert.equal(durationHours('n/a'), 0);
  assert.equal(durationHours(''), 0);
  assert.equal(durationHours(null), 0);
});

test('labor rates and cost', () => {
  const rates = { drafting: 80, other: 40 };
  assert.equal(laborRate(true, rates), 80);
  assert.equal(laborRate(false, rates), 40);
  assert.equal(laborCost(2, 3, rates), 280);
  assert.equal(laborCost(0, 0, rates), 0);
});

test('labor rules: overhead wins, then drafting by department or item', async () => {
  const { laborRules, classifyLabor } = await import('../core/index.mjs');
  const rules = laborRules(
    [{ Name: 'Detailing', Type: 'Draw Direct' }, { Name: 'Sanding', Type: 'Shop Direct' }],
    { overhead_items: ['MEETINGS'], drafting_items: ['Engineering'], drafting_type_prefix: 'Draw', drafting_department_prefix: '9 -' });
  assert.equal(classifyLabor('MEETINGS', '9 - Drawing', rules), 'overhead');
  assert.equal(classifyLabor('Sanding', '9 - Drawing', rules), 'drafting');      // by department
  assert.equal(classifyLabor('Detailing', '1 - Shop', rules), 'drafting');       // by item type
  assert.equal(classifyLabor('Engineering', '1 - Shop', rules), 'drafting');     // listed item
  assert.equal(classifyLabor('Sanding', '1 - Shop', rules), 'other');
  assert.equal(classifyLabor(null, null, rules), 'other');
});
