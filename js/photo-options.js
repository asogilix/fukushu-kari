import { retrievability } from './review.js';

export const TAGS = [
  { id: 'star', color: '赤' },
  { id: 'alert', color: '黄' },
  { id: 'question', color: '緑' }
];

export const PHOTO_SORTS = [
  { id: 'newest', label: '新しい順' },
  { id: 'oldest', label: '古い順' },
  { id: 'memory', label: '忘れていそうな順' }
];

export function normalizePhotoTags(tags) {
  if (!Array.isArray(tags)) return [];
  return TAGS.map(({ id }) => id).filter(id => tags.includes(id));
}

export function togglePhotoTag(tags, id) {
  const current = normalizePhotoTags(tags);
  return current.includes(id) ? current.filter(tag => tag !== id) : normalizePhotoTags([...current, id]);
}

export function normalizePhotoPreferences(value) {
  return {
    sort: PHOTO_SORTS.some(({ id }) => id === value?.sort) ? value.sort : 'oldest',
    filter: TAGS.some(({ id }) => id === value?.filter) ? value.filter : 'all',
    importNote: value?.importNote === true
  };
}

export function selectPhotos(photos, { sort, filter }, now) {
  const visible = filter === 'all' ? photos : photos.filter(photo =>
    Array.isArray(photo.tags) && photo.tags.includes(filter));
  const sortKey = photo => {
    if (sort === 'newest') return -photo.importedAt;
    if (sort === 'memory') return photo.excluded ? Infinity : (retrievability(photo.card, now) ?? -1);
    return photo.importedAt;
  };
  return visible.map(photo => ({ photo, key: sortKey(photo) }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key - b.key;
      const imported = a.photo.importedAt - b.photo.importedAt;
      if (imported || a.photo.id === b.photo.id) return imported;
      return a.photo.id < b.photo.id ? -1 : 1;
    })
    .map(({ photo }) => photo);
}
