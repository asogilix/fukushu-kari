import { selectPhotos } from './photo-options.js';

export function viewerPhotoIds(photos, currentPhoto, preferences, now) {
  const inFolder = photos.filter(photo => photo.folderId === currentPhoto.folderId);
  const visible = selectPhotos(inFolder, preferences, now);
  if (visible.some(photo => photo.id === currentPhoto.id)) return visible.map(photo => photo.id);
  if (!inFolder.some(photo => photo.id === currentPhoto.id)) return [currentPhoto.id];
  return selectPhotos(inFolder, { ...preferences, filter: 'all' }, now).map(photo => photo.id);
}

export function adjacentIndex(index, count, direction) {
  const next = index + direction;
  return direction !== 0 && next >= 0 && next < count ? next : null;
}

export function swipeDirection(distance, size, velocity) {
  const farEnough = Math.abs(distance) >= size * 0.2;
  const flick = Math.abs(distance) >= 24 && Math.sign(distance) * velocity >= 0.45;
  return distance !== 0 && (farEnough || flick) ? -Math.sign(distance) : 0;
}

export const clampZoom = scale => Math.max(1, Math.min(5, scale));
export const doubleTapZoom = scale => scale > 1 ? 1 : 2.5;
