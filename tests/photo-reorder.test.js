import assert from 'node:assert/strict';
import test from 'node:test';
import { moveItem } from '../js/photo-reorder.js';

test('写真を前や後ろへ移し、ほかの写真の順番は保つ', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(ids, 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(ids, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(ids, 2, 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveItem(ids, 2, 2), ids);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});
