import * as db from './db.js';
import { canHaveChildren, folderCounts, folderIdsInBranch, folderLocations, folderMenuItems, folderTree } from './folders.js';
import { normalizePhotoTags, PHOTO_SORTS, selectPhotos, TAGS } from './photo-options.js';
import { enablePhotoReorder } from './photo-reorder.js';
import { viewerPhotoIds } from './photo-viewer-logic.js';
import { duePhotos, nextReviewRefresh, retrievability, reviewIsDue } from './review.js';
import {
  actionSheet, button, dialog, el, folderSelect, formatDateTime, heading, labeled, link,
  photoPreview, photoSource, photoTagButtons, tagDot
} from './ui.js';
import { folderImport } from './workflow.js';

const COLLAPSED_FOLDERS = 'review-photo-album:collapsed-folders';
let closedFolders;

function readClosedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS));
    if (Array.isArray(saved)) return new Set(saved.filter(id => typeof id === 'string'));
  } catch {
    // A fresh view starts expanded if storage cannot be read.
  }
  return new Set();
}

async function editFolder(ctx, { folder, parent, locations }) {
  const input = el('input', {
    type: 'text', value: folder?.name ?? '', maxLength: 60, required: true, autofocus: true
  });
  input.oninput = () => input.setCustomValidity('');
  input.oninvalid = () => input.setCustomValidity('フォルダの名前を入れてください。');
  input.onchange = () => {
    input.value = input.value.trim();
    input.setCustomValidity(input.value ? '' : 'フォルダの名前を入れてください。');
  };
  const place = locations && el('select', {}, locations.map(({ value, label }) => el('option', { value }, label)));
  const title = folder ? '名前を変える' : parent ? 'この中にフォルダを作る' : 'フォルダを作る';
  const choice = await dialog(title, [
    labeled('フォルダの名前', input),
    place && labeled('作る場所', place)
  ], [['やめる', ''], [folder ? '保存する' : '作る', 'save', 'button primary']]);
  if (!choice || !input.value.trim()) return;
  const name = input.value.trim();
  if (folder) await db.renameFolder(folder.id, name);
  else await db.createFolder({
    id: crypto.randomUUID(), name, createdAt: Date.now(), parentId: parent?.id ?? (place?.value || null)
  });
  ctx.notify(folder ? '名前を変えました。' : 'フォルダを作りました。');
  ctx.refresh();
}

function folderRow(folder, { total, due }, { child = false, showChevron = false } = {}) {
  const markClass = folder.id === db.DEFAULT_FOLDER ? 'folder-mark folder-mark-unfiled' : 'folder-mark';
  return el('a', { className: 'folder-row', href: `#folder/${folder.id}` },
    el('span', { className: markClass, 'aria-hidden': 'true' }),
    el(child ? 'span' : 'strong', { className: 'folder-name' }, folder.name),
    due > 0 && el('span', { className: 'folder-due' },
      el('span', { className: 'visually-hidden' }, '今の復習 '), String(due),
      el('span', { className: 'visually-hidden' }, '枚')),
    el('span', { className: 'folder-total' },
      el('span', { className: 'visually-hidden' }, '写真 '), `${total}枚`),
    showChevron && el('span', { className: 'folder-row-chevron', 'aria-hidden': 'true' }, '›'));
}

function childFolderList(folders, counts, { showChevron = false } = {}) {
  return el('ul', { className: 'folder-list child-folders' },
    folders.map(folder => el('li', {}, folderRow(folder, counts.get(folder.id), { child: true, showChevron }))));
}

function homeFolderList(folders, counts) {
  const collapsed = closedFolders ??= readClosedFolders();
  return el('ul', { className: 'folder-list' }, folderTree(folders).map(({ folder, children }) => {
    const row = folderRow(folder, counts.get(folder.id));
    if (!children.length) return el('li', { className: 'folder-leaf' }, row);
    const childList = childFolderList(children, counts);
    childList.id = `children-${folder.id}`;
    const toggle = button('', () => {
      if (collapsed.has(folder.id)) collapsed.delete(folder.id);
      else collapsed.add(folder.id);
      update();
      try {
        localStorage.setItem(COLLAPSED_FOLDERS, JSON.stringify([...collapsed]));
      } catch {
        // Keep the current view usable if the browser blocks storage.
      }
    }, 'folder-toggle');
    toggle.setAttribute('aria-controls', childList.id);
    function update() {
      const open = !collapsed.has(folder.id);
      childList.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${folder.name}の中を${open ? '閉じる' : '開く'}`);
    }
    update();
    return el('li', {}, el('div', { className: 'folder-branch' }, toggle, row), childList);
  }));
}

export async function renderHome(ctx, _id, scope) {
  const [folders, photos] = await Promise.all([db.listFolders(), db.listPhotos()]);
  const now = new Date();
  const count = photos.filter(photo => reviewIsDue(photo, now)).length;
  const begin = button('始める', ctx.guard(async () => {
    const queue = duePhotos(await db.listPhotos(), new Date());
    if (!scope.current()) return;
    if (queue.length) ctx.startReview(queue);
    else ctx.refresh();
  }), 'button primary small');
  begin.disabled = count === 0;
  scope.refreshAt(nextReviewRefresh(photos, now));
  const stripClass = count === 0 ? 'review-strip review-strip-empty' : 'review-strip';
  return [
    el('section', { className: stripClass, 'aria-labelledby': 'review-title' },
      el('span', { className: 'calendar-mark', 'aria-hidden': 'true' }),
      el('div', { className: 'review-strip-copy' },
        el('h1', { id: 'review-title' }, '今の復習'),
        count > 0 ? el('strong', { className: 'review-strip-count' }, String(count), el('span', {}, '枚')) :
          el('p', { className: 'muted' }, '今は復習する写真はありません')),
      begin),
    el('section', { className: 'section', 'aria-labelledby': 'folders-title' },
      el('div', { className: 'section-heading' }, el('h2', { id: 'folders-title' }, 'フォルダ'),
        button('＋ 作る', ctx.guard(() => editFolder(ctx, { locations: folderLocations(folders) })), 'button small')),
      homeFolderList(folders, folderCounts(folders, photos, now)))
  ];
}

function photoTitle(photo) {
  if (photo.source) {
    const name = photo.source.name.replace(/\.pdf$/i, '') || 'PDF';
    return `${name} ${photo.source.page}ページ`;
  }
  return formatDateTime(photo.fileModifiedAt ?? photo.importedAt);
}

function thumbnails(scope) {
  const tiles = new Map();
  async function load(image) {
    try {
      const record = await db.getImage(image.dataset.photoId);
      if (scope.current() && record?.full) image.src = scope.blobUrl(record.thumb ?? record.full);
    } catch {
      image.classList.add('unavailable');
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      load(entry.target);
    }
  }, { rootMargin: '240px' });
  scope.onLeave(() => observer.disconnect());
  return photos => photos.map(photo => {
    if (tiles.has(photo.id)) return tiles.get(photo.id);
    const image = el('img', { alt: '', 'data-photo-id': photo.id, decoding: 'async', draggable: false });
    observer.observe(image);
    const title = photo.note.split(/\r?\n/, 1)[0].trim() || photoTitle(photo);
    const tags = normalizePhotoTags(photo.tags);
    const marks = TAGS.filter(tag => tags.includes(tag.id));
    const tile = el('li', { 'data-photo-id': photo.id },
      el('a', { className: 'tile', href: `#photo/${photo.id}`, draggable: false },
        el('span', { className: 'tile-image' }, image,
          marks.length > 0 && el('span', { className: 'tile-tags' }, marks.map(tagDot))),
        el('span', { className: 'tile-title', title }, title),
        marks.length > 0 && el('span', { className: 'visually-hidden' }, marks.map(tag => `${tag.color}の印`).join('、'))));
    tiles.set(photo.id, tile);
    return tile;
  });
}

function folderPhotoList(ctx, folder, photos, preferences, now, scope) {
  let selected = preferences;
  let pendingOrder;
  let pendingPreferences = 0;
  const choose = (key, value) => ctx.guard(async () => {
    if (pendingOrder) await pendingOrder;
    if (selected[key] === value || !scope.current()) return;
    cancelReorder();
    pendingPreferences++;
    try {
      await db.updatePhotoPreferences({ [key]: value });
      const saved = await db.getPhotoPreferences();
      if (!scope.current()) return;
      selected = saved;
      update(new Date());
    } finally {
      pendingPreferences--;
    }
  });
  const sorts = PHOTO_SORTS.map(({ id, label }) => el('button', {
    type: 'button', className: 'sort-choice', 'data-sort': id, onclick: choose('sort', id)
  }, label));
  const filters = [
    el('button', {
      type: 'button', className: 'button small tag-filter-all', 'data-filter': 'all', onclick: choose('filter', 'all')
    }, 'すべて'),
    ...TAGS.map(tag => el('button', {
      type: 'button', className: 'button tag-filter-button', 'data-filter': tag.id,
      'aria-label': `${tag.color}の印でしぼりこむ`, onclick: choose('filter', tag.id)
    }, tagDot(tag)))
  ];
  const status = el('p', { className: 'photo-filter-status', role: 'status' });
  const hint = el('p', { className: 'photo-reorder-hint' }, '長押しすると、写真を動かせます');
  const tiles = el('ul', { className: 'tiles' });
  const getTiles = thumbnails(scope);
  const empty = el('p', { className: 'empty' },
    photos.length ? 'この印がついた写真はありません。' : 'このフォルダには、まだ写真がありません。');

  function update(at) {
    const visible = selectPhotos(photos, selected, at);
    for (const choice of sorts) choice.setAttribute('aria-pressed', String(choice.dataset.sort === selected.sort));
    for (const choice of filters) choice.setAttribute('aria-pressed', String(choice.dataset.filter === selected.filter));
    const tag = TAGS.find(({ id }) => id === selected.filter);
    status.hidden = !tag;
    if (tag) status.replaceChildren(
      el('span', { className: 'visually-hidden' }, `${tag.color}の印でしぼりこみ中`),
      tagDot(tag), `（${visible.length}枚）`);
    tiles.hidden = visible.length === 0;
    tiles.replaceChildren(...getTiles(visible));
    hint.hidden = tiles.hidden;
    empty.hidden = !tiles.hidden;
  }

  const saveOrder = ctx.guard(async orderedIds => {
    try {
      await db.reorderPhotos(folder.id, orderedIds);
      if (!scope.current()) return;
      const positions = new Map(orderedIds.map((id, position) => [id, position]));
      for (const photo of photos) photo.position = positions.get(photo.id);
      selected = { ...selected, sort: 'manual' };
    } catch (error) {
      if (scope.current()) ctx.refresh();
      throw error;
    } finally {
      pendingOrder = undefined;
      if (scope.current()) update(new Date());
    }
  });
  const cancelReorder = enablePhotoReorder(tiles, {
    ready: () => !pendingOrder && pendingPreferences === 0,
    filtered: () => selected.filter !== 'all',
    onBlocked: () => ctx.notify('順番を変えるときは、しぼりこみを「すべて」にしてください。'),
    onDrop(orderedIds) { pendingOrder = saveOrder(orderedIds); }
  }, scope);

  update(now);
  return el('section', { className: 'section folder-card' },
    el('h2', {}, `${folder.name}の写真`),
    el('div', { className: 'photo-toolbelt' },
      el('div', { className: 'sort-control', role: 'group', 'aria-label': '並べかえ' }, sorts),
      el('div', { className: 'photo-filter-controls', role: 'group', 'aria-labelledby': 'photo-filter-label' },
        el('span', { id: 'photo-filter-label' }, 'しぼりこみ'),
        el('div', { className: 'photo-filter-options' }, filters))),
    status, hint, tiles, empty);
}

export async function renderFolder(ctx, id, scope) {
  const [all, folders, preferences] = await Promise.all([db.listPhotos(), db.listFolders(), db.getPhotoPreferences()]);
  const folder = folders.find(record => record.id === id);
  if (!folder) return [heading('フォルダが見つかりません', 'ほーむ\u2002へ', '#home')];
  const parent = folders.find(record => record.id === folder.parentId);
  const children = folderTree(folders).find(entry => entry.folder.id === id)?.children ?? [];
  const photos = all.filter(photo => photo.folderId === id);
  const branch = folderIdsInBranch(folders, id);
  const now = new Date();
  const counts = folderCounts(folders, all, now);
  const { total, due } = counts.get(id);
  scope.refreshAt(nextReviewRefresh(all.filter(photo => branch.has(photo.folderId)), now));
  const remove = ctx.guard(async () => {
    const destination = parent?.name ?? folders.find(record => record.id === db.DEFAULT_FOLDER).name;
    const folderText = children.length ? `このフォルダと中の${children.length}個、合わせて${branch.size}個のフォルダ` :
      'このフォルダ1個';
    const choice = await dialog('フォルダを消しますか？', el('div', { className: 'dialog-copy' },
      el('p', {}, `${folderText}が消えます。`),
      el('p', {}, `写真${total}枚を一緒に消すか、「${destination}」に移すか選んでください。`)), [
        ['やめる', ''], [parent ? '1つ上に移す' : `「${destination}」に移す`, 'move', 'button primary'],
        [`写真${total}枚も消す`, 'delete', 'button danger']
      ]);
    if (!choice) return;
    await db.deleteFolder(id, choice === 'move');
    ctx.notify('フォルダを消しました。');
    ctx.navigate(parent ? `#folder/${parent.id}` : '#home');
  });
  const start = button(due ? `このフォルダを復習（${due}枚）` : '今は復習する写真はありません', ctx.guard(async () => {
    const [latestPhotos, latestFolders] = await Promise.all([db.listPhotos(), db.listFolders()]);
    if (!scope.current()) return;
    const latestBranch = folderIdsInBranch(latestFolders, id);
    const queue = duePhotos(latestPhotos.filter(photo => latestBranch.has(photo.folderId)), new Date());
    if (queue.length) ctx.startReview(queue, folder);
    else ctx.refresh();
  }), 'button folder-review');
  start.disabled = due === 0;

  const destinations = parent ? folders.filter(record => canHaveChildren(record) && record.id !== parent.id) : [];
  const actions = {
    rename: ctx.guard(() => editFolder(ctx, { folder })),
    create: ctx.guard(() => editFolder(ctx, { parent: folder })),
    move: ctx.guard(async () => {
      const select = folderSelect(destinations);
      if (!await dialog('フォルダを移す', labeled('移す先のフォルダ', select),
        [['やめる', ''], ['移す', 'move', 'button primary']])) return;
      await db.moveFolder(id, select.value);
      ctx.notify('フォルダを移しました。');
      ctx.refresh();
    }),
    remove
  };
  const more = button('︙', () => {
    actionSheet('そのほかの操作', folderMenuItems(folder, destinations.length > 0).map(item => ({
      ...item, run: actions[item.id]
    })));
  }, 'button more-button');
  more.setAttribute('aria-label', 'そのほかの操作');
  more.setAttribute('aria-haspopup', 'dialog');
  const separator = () => el('span', { 'aria-hidden': 'true' }, '›');
  const breadcrumb = el('nav', { className: 'breadcrumb', 'aria-label': '今いる場所' },
    link('ほーむ', '#home', 'breadcrumb-link'), separator(),
    parent && [link(parent.name, `#folder/${parent.id}`, 'breadcrumb-link'), separator()],
    el('span', { 'aria-current': 'page' }, folder.name));

  return [
    el('header', { className: 'page-heading' }, breadcrumb,
      el('div', { className: 'folder-summary' },
        el('div', { className: 'folder-heading' }, el('h1', {}, folder.name),
          el('span', { className: 'folder-total' }, `写真 ${total}枚`)),
        el('div', { className: 'folder-operations' }, start,
          el('div', { className: 'folder-controls' }, folderImport(ctx, id), more)))),
    children.length > 0 && el('section', { className: 'section folder-card child-folders-card' },
      el('h2', {}, `${folder.name}の中のフォルダ`), childFolderList(children, counts, { showChevron: true })),
    folderPhotoList(ctx, folder, photos, preferences, now, scope)
  ];
}

export async function renderPhoto(ctx, id, scope) {
  const [photo, image, folders] = await Promise.all([db.getPhoto(id), db.getImage(id), db.listFolders()]);
  if (!photo || !image?.full) return [heading('写真が見つかりません', 'ほーむ\u2002へ', '#home')];
  const back = `#folder/${photo.folderId}`;
  const due = el('p', { className: 'due-info' });
  const memory = el('p', { className: 'muted' });
  const showDue = excluded => {
    memory.hidden = excluded;
    if (excluded) {
      due.textContent = '復習しない写真です。';
      return;
    }
    const now = new Date();
    const date = new Date(photo.card.due);
    const next = formatDateTime(date, {
      withTime: photo.card.scheduled_days === 0, withYear: date.getFullYear() !== now.getFullYear()
    });
    const chance = retrievability(photo.card, now);
    due.textContent = `次の復習：${next}`;
    memory.textContent = chance === null ? '今、覚えている見こみ：初回の復習後に表示します。' :
      `今、覚えている見こみ：約${Math.round(chance * 100)}%`;
  };
  showDue(photo.excluded);
  const noteStatus = el('span', { className: 'muted', role: 'status' }, '書いた内容は自動で保存します。');
  const note = el('textarea', { value: photo.note, rows: 2, placeholder: '覚えたいことを書く' });
  let noteVersion = 0;
  note.oninput = async () => {
    const version = ++noteVersion;
    noteStatus.textContent = '保存中…';
    try {
      await db.updatePhoto(id, { note: note.value });
      if (version === noteVersion) noteStatus.textContent = 'メモを保存しました。';
    } catch {
      if (version === noteVersion) noteStatus.textContent = 'メモを保存できませんでした。';
    }
  };
  const toggle = el('input', { type: 'checkbox', checked: photo.excluded });
  toggle.onchange = async () => {
    const checked = toggle.checked;
    toggle.disabled = true;
    try {
      await db.updatePhoto(id, { excluded: checked });
      showDue(checked);
    } catch {
      toggle.checked = !checked;
      ctx.notify('復習するかどうかを保存できませんでした。');
    } finally {
      toggle.disabled = false;
    }
  };
  const move = ctx.guard(async () => {
    const select = folderSelect(folders, photo.folderId);
    if (!await dialog('写真を移す', labeled('移す先のフォルダ', select),
      [['やめる', ''], ['移す', 'move', 'button primary']]) || select.value === photo.folderId) return;
    await db.updatePhoto(id, { folderId: select.value });
    ctx.notify('写真を移しました。');
    ctx.refresh();
  });
  const remove = ctx.guard(async () => {
    if (!await dialog('写真を消しますか？', el('p', {}, '写真とメモが消えます。'), [
      ['やめる', ''], ['消す', 'delete', 'button danger']
    ])) return;
    await db.deletePhoto(id);
    ctx.notify('写真を消しました。');
    ctx.navigate(back);
  });
  const url = scope.blobUrl(image.full);
  const openPreview = () => {
    if (!scope.current()) return;
    ctx.openPhotoViewer({
      photoId: id, url, alt: '勉強用の写真',
      async loadPhotoIds() {
        const [photos, preferences] = await Promise.all([db.listPhotos(), db.getPhotoPreferences()]);
        const current = photos.find(item => item.id === id) ?? photo;
        return viewerPhotoIds(photos, current, preferences, new Date());
      }
    });
  };
  return [
    heading(photoTitle(photo), 'フォルダへ', back),
    photoSource(photo),
    photoPreview(url, openPreview),
    photoTagButtons(photo.tags, ctx.guard(tag => db.toggleStoredPhotoTag(id, tag))),
    el('section', { className: 'panel photo-note' }, labeled('メモ', note), noteStatus),
    el('section', { className: 'panel' }, due, memory,
      el('label', { className: 'toggle' }, toggle, '復習しない'),
      el('div', { className: 'actions' },
        button('別のフォルダへ移す', move), button('写真を消す', remove, 'button danger')))
  ];
}
