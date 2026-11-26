import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPhotos } from '../js/photo-options.js';
import { adjacentIndex, clampZoom, doubleTapZoom, swipeDirection, viewerPhotoIds } from '../js/photo-viewer-logic.js';
import { newReview } from '../js/review.js';

const now = new Date(2026, 10, 21, 14);
const photo = (id, importedAt, tags, folderId = 'folder', excluded = false) =>
  ({ id, folderId, importedAt, tags, excluded, card: newReview(now) });
const current = photo('current', 2, ['star']);
const outsideFilter = photo('outside-filter', 3);
const photos = [photo('newer', 4, ['star'], 'folder', true), photo('child', 0, ['star'], 'child'),
  outsideFilter, photo('older', 1, ['star']), current, photo('other', 5, ['star'], 'other')];

test('全画面の順番はフォルダ直下の一覧と一致し、保存したしぼりこみを使う', () => {
  const inFolder = photos.filter(item => item.folderId === current.folderId);
  for (const sort of ['oldest', 'newest', 'memory']) {
    for (const filter of ['all', 'star']) {
      const preferences = { sort, filter };
      const expected = selectPhotos(inFolder, preferences, now).map(item => item.id);
      assert.deepEqual(viewerPhotoIds(photos, current, preferences, now), expected);
    }
  }
  assert.deepEqual(viewerPhotoIds(photos, current, { sort: 'newest', filter: 'star' }, now),
    ['newer', 'current', 'older']);
});

test('開いた写真がしぼりこみの外にあれば、しぼりこみを外して保存した並べ方を使う', () => {
  assert.deepEqual(viewerPhotoIds(photos, outsideFilter, { sort: 'newest', filter: 'star' }, now),
    ['newer', 'outside-filter', 'current', 'older']);
  assert.deepEqual(viewerPhotoIds(photos, current, { sort: 'memory', filter: 'question' }, now),
    ['older', 'current', 'outside-filter', 'newer']);
  assert.deepEqual(viewerPhotoIds([], current, { sort: 'oldest', filter: 'all' }, now), ['current']);
});

test('自分の順では全画面でもフォルダ内の指定順になり、順番がない写真はうしろに並ぶ', () => {
  const ordered = photos.map(item => item.id === 'newer' ? { ...item, position: 0 } : item);
  assert.deepEqual(viewerPhotoIds(ordered, current, { sort: 'manual', filter: 'all' }, now),
    ['newer', 'older', 'current', 'outside-filter']);
  assert.deepEqual(viewerPhotoIds(ordered, current, { sort: 'manual', filter: 'star' }, now),
    ['newer', 'older', 'current']);
});

test('前と次の位置を返し、一覧の両端と1枚だけのときは範囲を越えない', () => {
  assert.equal(adjacentIndex(1, 3, -1), 0);
  assert.equal(adjacentIndex(1, 3, 1), 2);
  assert.equal(adjacentIndex(0, 3, -1), null);
  assert.equal(adjacentIndex(2, 3, 1), null);
  assert.equal(adjacentIndex(1, 3, 0), null);
  assert.equal(adjacentIndex(0, 1, -1), null);
  assert.equal(adjacentIndex(0, 1, 1), null);
});

test('横幅の20%以上のスライドは左右に応じて前・次へ移る', () => {
  assert.equal(swipeDirection(-72, 360, 0), 1);
  assert.equal(swipeDirection(82.4, 412, 0), -1);
  assert.equal(swipeDirection(-71.9, 360, -0.2), 0);
});

test('短くても同じ向きに勢いよくはじけば移り、小さな動きや逆向きのはじきは戻る', () => {
  assert.equal(swipeDirection(-24, 400, -0.45), 1);
  assert.equal(swipeDirection(24, 400, 0.6), -1);
  assert.equal(swipeDirection(23, 400, 0.8), 0);
  assert.equal(swipeDirection(-44, 400, -0.44), 0);
  assert.equal(swipeDirection(-44, 400, 0.8), 0);
  assert.equal(swipeDirection(0, 400, 1), 0);
});

test('拡大率を1〜5倍に収め、2回押しで約2.5倍と等倍を切り替える', () => {
  assert.equal(clampZoom(0.5), 1);
  assert.equal(clampZoom(2.7), 2.7);
  assert.equal(clampZoom(6), 5);
  assert.equal(doubleTapZoom(1), 2.5);
  assert.equal(doubleTapZoom(2.5), 1);
  assert.equal(doubleTapZoom(5), 1);
});
