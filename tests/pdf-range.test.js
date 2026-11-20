import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePageRange } from '../js/import.js';

test('空白、1ページ、範囲を指定できる', () => {
  assert.deepEqual(parsePageRange(' ', 12), [1, 12]);
  assert.deepEqual(parsePageRange('5', 12), [5, 5]);
  assert.deepEqual(parsePageRange('3-10', 12), [3, 10]);
  assert.deepEqual(parsePageRange('３ ～ １０', 12), [3, 10]);
});

test('文書にないページや逆順の範囲は使えない', () => {
  for (const range of ['0-5', '8-3', '5-13', '1,2', '-3']) {
    assert.throws(() => parsePageRange(range, 12), /ページ/);
  }
});
