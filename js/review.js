import { createEmptyCard, default_request_retention, fsrs, Rating, State } from '../vendor/ts-fsrs/index.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAY_START = 4;
export const DEFAULT_RETENTION = default_request_retention;
export const MIN_RETENTION = 0.80;
export const MAX_RETENTION = 0.95;
export const RETENTION_SETTING = 'reviewRetention';

export function reviewRetention(value) {
  return Number.isFinite(value) && value >= MIN_RETENTION && value <= MAX_RETENTION
    ? value : DEFAULT_RETENTION;
}

function dateString(year, month, day) {
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'),
    String(day).padStart(2, '0')].join('-');
}

export function localDay(now = new Date()) {
  return dateString(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function utcDay(day) {
  return new Date(`${day}T00:00:00Z`);
}

// These helpers count calendar days without depending on daylight saving.
export function addDays(day, count) {
  const date = utcDay(day);
  date.setUTCDate(date.getUTCDate() + count);
  return dateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function daysBetween(start, end) {
  return (utcDay(end) - utcDay(start)) / DAY;
}

export function isCalendarDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    addDays(value, 0) === value;
}

export function reviewDay(now) {
  const date = new Date(now);
  const day = localDay(date);
  return date.getHours() < DAY_START ? addDays(day, -1) : day;
}

export function reviewDayStart(now, days = 0) {
  return new Date(`${addDays(reviewDay(now), days)}T04:00:00`);
}

// ts-fsrs counts UTC calendar days. Use the app's 4 a.m. days on that calendar.
const schedulerDay = now => utcDay(reviewDay(now));

function saveCard({ due, last_review, ...card }) {
  return { ...card, due: due.toISOString(), last_review: last_review?.toISOString() ?? null };
}

export function newReview(now) {
  return createEmptyCard(new Date(+new Date(now) + HOUR), saveCard);
}

export function migrateLegacyPhoto({ stage, due, title, ...photo }, now) {
  return { ...photo, card: createEmptyCard(new Date(now), saveCard) };
}

export function answerReview(card, answer, now, retention) {
  if (answer === 'later') return { card, log: null };
  const grade = answer === 'remembered' ? Rating.Good : answer === 'forgot' ? Rating.Again : null;
  if (grade === null) throw new RangeError('復習の答えが正しくありません。');

  const scheduler = fsrs({
    request_retention: reviewRetention(retention),
    learning_steps: ['10m'],
    relearning_steps: ['10m']
  });
  const reviewedAt = new Date(now);
  const schedulerNow = schedulerDay(reviewedAt);
  const lastReview = card.last_review;
  const result = scheduler.next({
    ...card, last_review: lastReview ? schedulerDay(lastReview) : null
  }, schedulerNow, grade);
  const next = result.card;
  next.due = next.scheduled_days > 0 ? reviewDayStart(reviewedAt, next.scheduled_days)
    : new Date(+reviewedAt + (next.due - schedulerNow));
  next.last_review = reviewedAt;
  return {
    card: saveCard(next),
    log: {
      ...result.log,
      // ReviewLog.due holds the previous review time, or the first deadline.
      due: lastReview ?? result.log.due.toISOString(),
      review: reviewedAt.toISOString()
    }
  };
}

export function retrievability(card, now) {
  if (card.state === State.New) return null;
  return fsrs().get_retrievability({ ...card, last_review: schedulerDay(card.last_review) }, schedulerDay(now), false);
}

export function reviewIsDue(photo, now, folderId = '') {
  return !photo.excluded && (!folderId || photo.folderId === folderId) &&
    Date.parse(photo.card.due) <= +now;
}

export function duePhotos(photos, now, folderId = '') {
  return photos.filter(photo => reviewIsDue(photo, now, folderId))
    .sort((a, b) => a.card.due.localeCompare(b.card.due) || a.importedAt - b.importedAt);
}

export function upcomingCount(photos, now, folderId = '') {
  const tomorrow = +reviewDayStart(now, 1);
  let count = 0;
  for (const photo of photos) {
    if (photo.excluded || (folderId && photo.folderId !== folderId)) continue;
    const due = Date.parse(photo.card.due);
    if (due > +now && due < tomorrow) count++;
  }
  return count;
}

export function nextReviewRefresh(photos, now) {
  let next = +reviewDayStart(now, 1);
  for (const photo of photos) {
    if (photo.excluded) continue;
    const due = Date.parse(photo.card.due);
    if (due > +now && due < next) next = due;
  }
  return next;
}
