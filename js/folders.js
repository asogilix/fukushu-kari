import { reviewIsDue } from './review.js';

export const DEFAULT_FOLDER = 'unfiled';

export function canHaveChildren(folder) {
  return Boolean(folder && folder.id !== DEFAULT_FOLDER && folder.parentId == null);
}

export function normalizeFolders(folders) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  return folders.map(folder => ({
    ...folder,
    parentId: folder.id !== DEFAULT_FOLDER && canHaveChildren(byId.get(folder.parentId))
      ? folder.parentId : null
  }));
}

function sortedFolders(folders) {
  return [...folders].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'ja'));
}

export function folderTree(folders) {
  const roots = new Map();
  const sorted = sortedFolders(folders);
  for (const folder of sorted) {
    if (folder.parentId == null && folder.id !== DEFAULT_FOLDER) {
      roots.set(folder.id, { folder, children: [] });
    }
  }
  const unfiled = sorted.find(folder => folder.id === DEFAULT_FOLDER);
  if (unfiled) roots.set(unfiled.id, { folder: unfiled, children: [] });
  for (const folder of sorted) {
    if (folder.parentId) roots.get(folder.parentId)?.children.push(folder);
  }
  return [...roots.values()];
}

export function folderLocations(folders) {
  return [
    { value: '', label: 'いちばん上' },
    ...sortedFolders(folders.filter(canHaveChildren)).map(folder => ({
      value: folder.id, label: `${folder.name}の中`
    }))
  ];
}

export function folderMenuItems(folder, canMove) {
  const items = [{ id: 'rename', label: '名前を変える' }];
  if (folder.id === DEFAULT_FOLDER) return items;
  if (canHaveChildren(folder)) {
    items.push({ id: 'create', label: 'この中にフォルダを作る' });
  } else {
    items.push({ id: 'move', label: '別のフォルダの中へ移す', disabled: !canMove });
  }
  items.push({ id: 'remove', label: 'フォルダを消す…', danger: true });
  return items;
}

export function folderIdsInBranch(folders, id) {
  const ids = new Set([id]);
  for (const folder of folders) {
    if (folder.parentId === id) ids.add(folder.id);
  }
  return ids;
}

export function folderCounts(folders, photos, now) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const counts = new Map(folders.map(folder => [folder.id, { total: 0, due: 0 }]));
  for (const photo of photos) {
    const count = counts.get(photo.folderId);
    if (!count) continue;
    const due = Number(reviewIsDue(photo, now));
    count.total++;
    count.due += due;
    const parent = counts.get(byId.get(photo.folderId).parentId);
    if (parent) {
      parent.total++;
      parent.due += due;
    }
  }
  return counts;
}
