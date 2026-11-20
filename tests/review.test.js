import assert from 'node:assert/strict';
import test from 'node:test';
import { Rating, State } from '../vendor/ts-fsrs/index.mjs';
import {
  addDays, answerReview, daysBetween, duePhotos, isCalendarDay, localDay, migrateLegacyPhoto,
  newReview, nextReviewRefresh, retrievability, reviewDay, reviewDayStart, reviewRetention, upcomingCount
} from '../js/review.js';

const minutesAfter = (time, minutes) => new Date(+time + minutes * 60_000);
const importedAt = new Date(2026, 10, 21, 14);
const firstDue = minutesAfter(importedAt, 60);
const newCard = newReview(importedAt);

test('取りこんで59分では出ず、1時間から復習に出る', () => {
  const photos = [{ id: 'photo', importedAt: +importedAt, card: newCard }];
  assert.equal(newCard.state, State.New);
  assert.equal(newCard.last_review, null);
  assert.equal(newCard.due, firstDue.toISOString());
  assert.deepEqual(duePhotos(photos, minutesAfter(importedAt, 59)), []);
  assert.deepEqual(duePhotos(photos, firstDue), photos);
  assert.deepEqual(duePhotos(photos, minutesAfter(importedAt, 61)), photos);
  assert.equal(upcomingCount(photos, importedAt), 1);
  assert.equal(upcomingCount(photos, firstDue), 0);
  assert.equal(nextReviewRefresh(photos, importedAt), +firstDue);
});

test('初回に覚えてたと答えると次は1日以上先の朝4時になる', () => {
  const { card, log } = answerReview(newCard, 'remembered', firstDue);
  assert.equal(card.state, State.Review);
  assert.equal(card.reps, 1);
  assert.equal(log.rating, Rating.Good);
  assert.equal(log.state, State.New);
  assert.equal(log.review, firstDue.toISOString());
  assert.ok(card.scheduled_days >= 1);
  assert.equal(card.due, reviewDayStart(firstDue, card.scheduled_days).toISOString());
  assert.deepEqual(duePhotos([{ card }], minutesAfter(new Date(card.due), -1)), []);
  assert.equal(duePhotos([{ card }], new Date(card.due)).length, 1);
});

test('初回でも覚えた後でも、忘れてたと答えると10分後に復習に出る', () => {
  const learned = answerReview(newCard, 'remembered', firstDue).card;
  for (const [before, state] of [[newCard, State.Learning], [learned, State.Relearning]]) {
    const now = new Date(before.due);
    const { card, log } = answerReview(before, 'forgot', now);
    assert.equal(card.scheduled_days, 0);
    assert.equal(card.state, state);
    assert.equal(log.rating, Rating.Again);
    assert.equal(card.due, minutesAfter(now, 10).toISOString());
    assert.equal(reviewDay(card.due), reviewDay(now));
    assert.equal(upcomingCount([{ card }], now), 1);
    assert.equal(duePhotos([{ card }], minutesAfter(now, 9)).length, 0);
    assert.equal(duePhotos([{ card }], minutesAfter(now, 10)).length, 1);
    const retry = answerReview(card, 'remembered', new Date(card.due));
    assert.ok(retry.card.scheduled_days >= 1);
  }
});

test('朝4時まで10分を切っていても、見直しの間隔は10分とる', () => {
  const now = new Date(2026, 10, 22, 3, 56);
  const { card } = answerReview(newCard, 'forgot', now);
  assert.equal(card.due, new Date(2026, 10, 22, 4, 6).toISOString());
  assert.equal(upcomingCount([{ card }], now), 0);
  assert.equal(upcomingCount([{ card }], new Date(2026, 10, 22, 4)), 1);
});

test('目標の確率を上げると次の間隔が短くなる', () => {
  const interval = retention => answerReview(newCard, 'remembered', firstDue, retention).card.scheduled_days;
  assert.ok(interval(0.80) > interval(0.90));
  assert.ok(interval(0.90) > interval(0.95));
  assert.equal(interval(undefined), interval(0.90));
  assert.equal(reviewRetention(0.79), 0.90);
  assert.equal(reviewRetention(0.96), 0.90);
});

test('端末の午前2時は前の日、朝4時から次の日になる', () => {
  const early = new Date(2026, 10, 21, 2);
  assert.equal(localDay(early), '2026-11-21');
  assert.equal(reviewDay(early), '2026-11-20');
  assert.equal(reviewDay(new Date(2026, 10, 21, 3, 59, 59, 999)), '2026-11-20');
  assert.equal(reviewDay(new Date(2026, 10, 21, 4)), '2026-11-21');
  assert.equal(reviewDayStart(early, 1).getTime(), +new Date(2026, 10, 21, 4));
});

test('復習で答えた間の日数も夜中の0時では変わらない', () => {
  const night = new Date(2026, 10, 21, 23, 55);
  const learned = answerReview(newCard, 'forgot', night).card;
  const midnight = answerReview(learned, 'remembered', new Date(learned.due));
  assert.equal(midnight.log.elapsed_days, 0);
  assert.equal(midnight.log.due, night.toISOString());
  const morning = answerReview(learned, 'remembered', new Date(2026, 10, 22, 4));
  assert.equal(morning.log.elapsed_days, 1);
});

test('朝4時から数えて月またぎ、うるう日、年またぎを扱える', () => {
  assert.equal(reviewDay(new Date(2026, 4, 1, 2)), '2026-04-30');
  assert.equal(reviewDayStart(new Date(2026, 3, 30, 15), 1).getTime(), +new Date(2026, 4, 1, 4));
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(reviewDay(new Date(2027, 0, 1, 2)), '2026-12-31');
  const now = new Date(2026, 11, 31, 15);
  const { card } = answerReview(newReview(minutesAfter(now, -60)), 'remembered', now, 0.95);
  assert.equal(card.due, new Date(2027, 0, 1, 4).toISOString());
});

test('夏時間で時計が変わる日も端末の朝4時から復習できる', () => {
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-12-23', '2027-01-06'), 14);
  const before = new Date(2026, 2, 7, 4);
  assert.equal(reviewDayStart(before, 1).getTime(), +new Date(2026, 2, 8, 4));
});

test('最初の版の日付は存在する日付だけを受け入れる', () => {
  assert.equal(isCalendarDay('2028-02-29'), true);
  assert.equal(isCalendarDay('2026-02-29'), false);
  assert.equal(isCalendarDay('2026-02-30'), false);
  assert.equal(isCalendarDay('2026-2-3'), false);
});

test('期限の古い順に並べ、フォルダや復習しない写真をしぼれる', () => {
  const now = new Date(2026, 10, 22, 2);
  const photo = (id, due, importedAt, folderId = 'law', excluded = false) =>
    ({ id, card: { due: due.toISOString() }, importedAt, folderId, excluded });
  const past = minutesAfter(now, -60);
  const photos = [
    photo('current', now, 7),
    photo('ignored', past, 0, 'law', true),
    photo('past', past, 3),
    photo('other', past, 2, 'civil'),
    photo('later', minutesAfter(now, 60), 6),
    photo('later-other', minutesAfter(now, 1), 8, 'civil'),
    photo('later-ignored', minutesAfter(now, 1), 9, 'law', true),
    photo('tomorrow', new Date(2026, 10, 22, 4), 10),
    photo('old', past, 1)
  ];
  assert.deepEqual(duePhotos(photos, now).map(item => item.id), ['old', 'other', 'past', 'current']);
  assert.deepEqual(duePhotos(photos, now, 'law').map(item => item.id), ['old', 'past', 'current']);
  assert.equal(upcomingCount(photos, now), 2);
  assert.equal(upcomingCount(photos, now, 'law'), 1);
  assert.equal(nextReviewRefresh(photos, now), +minutesAfter(now, 1));
  assert.equal(nextReviewRefresh([], now), +new Date(2026, 10, 22, 4));
});

test('あとでを選ぶとカードを変えず記録も作らない', () => {
  const next = answerReview(newCard, 'later', firstDue);
  assert.equal(next.card, newCard);
  assert.equal(next.log, null);
});

test('カードと記録の日時はISO文字列で往復でき、次の計算も同じになる', () => {
  const rated = answerReview(newCard, 'remembered', firstDue);
  const saved = JSON.parse(JSON.stringify(rated));
  assert.deepEqual(saved, rated);
  for (const value of [saved.card.due, saved.card.last_review, saved.log.due, saved.log.review]) {
    assert.equal(typeof value, 'string');
    assert.equal(new Date(value).toISOString(), value);
  }
  const now = new Date(saved.card.due);
  assert.deepEqual(answerReview(saved.card, 'forgot', now), answerReview(rated.card, 'forgot', now));
  assert.equal(retrievability(newCard, firstDue), null);
  assert.equal(retrievability(rated.card, firstDue), 1);
  assert.equal(retrievability(saved.card, now), retrievability(rated.card, now));
  assert.ok(retrievability(saved.card, now) < 1);
});

test('最初の版の写真はメモや除外設定を保ち、移行時点で初回の期限を迎える', () => {
  const legacy = {
    id: 'old-photo', folderId: 'unfiled', importedAt: +importedAt, excluded: true,
    note: 'メモ', source: null, title: 'IMG_2026.jpg', stage: 4, due: '2027-02-01'
  };
  const migrated = migrateLegacyPhoto(legacy, firstDue);
  assert.deepEqual(migrated, {
    id: legacy.id, folderId: legacy.folderId, importedAt: legacy.importedAt,
    excluded: true, note: legacy.note, source: null,
    card: { ...newCard, due: firstDue.toISOString() }
  });
  assert.equal(duePhotos([migrated], firstDue).length, 0);
  assert.equal(duePhotos([{ ...migrated, excluded: false }], firstDue).length, 1);
  assert.equal(legacy.stage, 4);
});
