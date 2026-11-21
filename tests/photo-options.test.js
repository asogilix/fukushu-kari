import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhotoPreferences, selectPhotos, togglePhotoTag } from '../js/photo-options.js';
import { answerReview, newReview } from '../js/review.js';

const now = new Date(2026, 10, 21, 14);
const defaultPreferences = normalizePhotoPreferences();
const ids = photos => photos.map(({ id }) => id);

function photo(id, importedAt, card = newReview(now), excluded = false) {
  return { id, importedAt, card, excluded };
}

test('印は別々につけ外しでき、印のない写真にもつけられる', () => {
  const star = togglePhotoTag(undefined, 'star');
  const all = togglePhotoTag(togglePhotoTag(star, 'question'), 'alert');
  assert.deepEqual(star, ['star']);
  assert.deepEqual(all, ['star', 'alert', 'question']);
  assert.deepEqual(togglePhotoTag(all, 'alert'), ['star', 'question']);
  assert.deepEqual(togglePhotoTag(star, 'star'), []);
});

test('それぞれの印でしぼりこみ、印の項目がない古い写真もすべての一覧に出す', () => {
  const photos = [
    photo('old', 1), { ...photo('two-marks', 2), tags: ['star', 'question'] },
    { ...photo('alert', 3), tags: ['alert'] }, { ...photo('none', 4), tags: [] },
    { ...photo('star', 5), tags: ['star'] }
  ];
  for (const [filter, expected] of Object.entries({
    all: ['old', 'two-marks', 'alert', 'none', 'star'],
    star: ['two-marks', 'star'], alert: ['alert'], question: ['two-marks']
  })) {
    assert.deepEqual(ids(selectPhotos(photos, { ...defaultPreferences, filter }, now)), expected);
  }
  assert.deepEqual(ids(selectPhotos(photos, { sort: 'newest', filter: 'star' }, now)), ['star', 'two-marks']);
});

test('取りこんだ日時で新しい順と古い順に並べ、同時刻は写真の識別子の順になる', () => {
  const newest = { ...photo('newest', 30), fileModifiedAt: 0 };
  const photos = [photo('b', 20), photo('oldest', 10), newest, photo('a', 20)];
  assert.deepEqual(ids(selectPhotos(photos, { sort: 'newest', filter: 'all' }, now)), ['newest', 'a', 'b', 'oldest']);
  assert.deepEqual(ids(selectPhotos(photos, { sort: 'oldest', filter: 'all' }, now)), ['oldest', 'a', 'b', 'newest']);
  assert.deepEqual(ids(photos), ['b', 'oldest', 'newest', 'a']);
});

test('忘れていそうな順は未回答が先で、同じ見こみは取りこんだ順、復習しない写真は最後', () => {
  const earlier = new Date(+now - 48 * 3_600_000);
  const lower = answerReview(newReview(earlier), 'remembered', earlier).card;
  const higher = answerReview(newReview(now), 'remembered', now).card;
  const photos = [photo('b', 2, higher), photo('lower', 3, lower), photo('a', 2, higher),
    photo('higher-first', 1, higher), photo('unanswered-later', 4), photo('unanswered-first', 0),
    photo('excluded', 0, lower, true)];
  assert.deepEqual(ids(selectPhotos(photos, { sort: 'memory', filter: 'all' }, now)),
    ['unanswered-first', 'unanswered-later', 'lower', 'higher-first', 'a', 'b', 'excluded']);
});

test('一覧と取りこみのせっていは不明な値を初期値に戻す', () => {
  assert.deepEqual(defaultPreferences, { sort: 'oldest', filter: 'all', importNote: false });
  assert.deepEqual(normalizePhotoPreferences({ sort: 'unknown', filter: 'unknown', importNote: 'true' }),
    defaultPreferences);
});
