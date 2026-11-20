import { Rating, S_MIN, State } from '../vendor/ts-fsrs/index.mjs';
import { DEFAULT_FOLDER } from './db.js';
import { isCalendarDay, migrateLegacyPhoto } from './review.js';
import { readZip, writeZip } from './zip.js';

const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(value);
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const validIsoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const imagePath = id => `photos/${id}.jpg`;
const thumbPath = id => `thumbnails/${id}.jpg`;

export async function makeBackup({ folders, photos, images, reviewLogs = [] }, onProgress) {
  const metadata = new Blob([JSON.stringify({ version: 2, folders, photos, reviewLogs })]);
  if (metadata.size > MAX_METADATA_BYTES) throw new Error('バックアップの記録が多すぎます。');
  const entries = [['data.json', metadata]];
  for (const photo of photos) {
    const image = images.get(photo.id);
    if (!image?.full) throw new Error('保存できない写真があります。');
    entries.push([imagePath(photo.id), image.full]);
    if (image.thumb) entries.push([thumbPath(photo.id), image.thumb]);
  }
  return writeZip(entries, onProgress);
}

function requireBackup(condition) {
  if (!condition) throw new Error('写真帳のバックアップとして読みこめませんでした。');
}

function validReviewFields(record) {
  return record && [State.New, State.Learning, State.Review, State.Relearning].includes(record.state) &&
    Number.isFinite(record.stability) && record.stability >= 0 &&
    Number.isFinite(record.difficulty) && record.difficulty >= 0 && record.difficulty <= 10 &&
    [record.elapsed_days, record.scheduled_days, record.learning_steps].every(nonnegativeInteger) &&
    validIsoTime(record.due);
}

function validCard(card) {
  return validReviewFields(card) && nonnegativeInteger(card.reps) && nonnegativeInteger(card.lapses) &&
    card.lapses <= card.reps && (card.state === State.New
      ? card.last_review === null && card.reps === 0
      : validIsoTime(card.last_review) && card.reps > 0 && card.stability >= S_MIN && card.difficulty >= 1);
}

export async function openBackup(file, onProgress, now = new Date()) {
  const entries = await readZip(file, onProgress);
  const metadata = entries.get('data.json');
  requireBackup(metadata && metadata.size <= MAX_METADATA_BYTES);
  const data = JSON.parse(await metadata.text());
  const legacy = data?.version === 1;
  requireBackup((legacy || data?.version === 2) && Array.isArray(data.folders) && Array.isArray(data.photos) &&
    (legacy || Array.isArray(data.reviewLogs)));

  const folderIds = new Set();
  const folders = data.folders.map(folder => {
    requireBackup(folder && validId(folder.id) && !folderIds.has(folder.id) &&
      typeof folder.name === 'string' && folder.name.trim() && nonnegativeInteger(folder.createdAt));
    folderIds.add(folder.id);
    return { id: folder.id, name: folder.name, createdAt: folder.createdAt };
  });
  requireBackup(folderIds.has(DEFAULT_FOLDER));

  const images = new Map();
  const photos = data.photos.map(photo => {
    requireBackup(photo && validId(photo.id) && !images.has(photo.id) &&
      folderIds.has(photo.folderId) && nonnegativeInteger(photo.importedAt) &&
      typeof photo.note === 'string' && typeof photo.excluded === 'boolean');
    const { id, folderId, importedAt, excluded, note, source, fileModifiedAt, card } = photo;
    requireBackup(source === null ||
      (source && typeof source.name === 'string' && Number.isSafeInteger(source.page) && source.page > 0));
    if (legacy) {
      requireBackup(typeof photo.title === 'string' && nonnegativeInteger(photo.stage) && isCalendarDay(photo.due));
    } else {
      requireBackup(validCard(card) && (fileModifiedAt === undefined ||
        (Number.isSafeInteger(fileModifiedAt) && Number.isFinite(+new Date(fileModifiedAt)))));
    }
    const original = entries.get(imagePath(id));
    const preview = entries.get(thumbPath(id));
    requireBackup(original?.size > 0 && (!preview || preview.size > 0));
    images.set(id, {
      id, full: original.slice(0, original.size, 'image/jpeg'),
      thumb: preview?.slice(0, preview.size, 'image/jpeg')
    });
    const record = { id, folderId, importedAt, excluded, note, source: source && { name: source.name, page: source.page } };
    if (legacy) return { ...record, card: migrateLegacyPhoto(photo, now).card };
    return { ...record, card, ...(fileModifiedAt === undefined ? {} : { fileModifiedAt }) };
  });
  const logIds = new Set();
  const reviewLogs = (legacy ? [] : data.reviewLogs).map(log => {
    requireBackup(validReviewFields(log) && validId(log.id) && !logIds.has(log.id) &&
      images.has(log.photoId) && [Rating.Again, Rating.Good].includes(log.rating) &&
      validIsoTime(log.review) && nonnegativeInteger(log.last_elapsed_days));
    logIds.add(log.id);
    return log;
  });
  return { folders, photos, images, reviewLogs };
}
