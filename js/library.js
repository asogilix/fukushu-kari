import * as db from './db.js';
import { daysBetween, duePhotos, localDay, nextReviewRefresh, retrievability, reviewIsDue, upcomingCount } from './review.js';
import { button, description, dialog, el, folderSelect, formatDateTime, heading, labeled, link, photoZoom } from './ui.js';

export function sortedFolders(folders) {
  return folders.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'ja'));
}

async function editFolder(ctx, folder) {
  const input = el('input', {
    type: 'text', value: folder?.name ?? '', maxLength: 60, required: true, autofocus: true
  });
  input.oninput = () => input.setCustomValidity('');
  input.oninvalid = () => input.setCustomValidity('フォルダの名前を入れてください。');
  input.onchange = () => {
    input.value = input.value.trim();
    input.setCustomValidity(input.value ? '' : 'フォルダの名前を入れてください。');
  };
  const choice = await dialog(folder ? '名前を変える' : 'フォルダを作る', labeled('フォルダの名前', input),
    [['やめる', ''], ['保存する', 'save', 'button primary']]);
  if (!choice || !input.value.trim()) return;
  const record = folder ?? { id: crypto.randomUUID(), createdAt: Date.now() };
  await db.saveFolder({ ...record, name: input.value.trim() });
  ctx.notify(folder ? '名前を変えました。' : 'フォルダを作りました。');
  ctx.refresh();
}

export function backupAge(last, today = localDay()) {
  if (!last) return { text: '最後のバックアップ：まだありません', old: false };
  const days = Math.max(0, daysBetween(last, today));
  return { text: `最後のバックアップ：${days ? `${days}日前` : '今日'}`, old: days >= 14 };
}

export async function renderHome(ctx, _id, scope) {
  const [folders, photos, last] = await Promise.all([
    db.listFolders(), db.listPhotos(), db.getSetting('lastBackup')
  ]);
  sortedFolders(folders);
  const now = new Date();
  const filter = folderSelect(folders, ctx.reviewFolder, true);
  const title = el('span', { className: 'hero-title' }, '今の復習');
  const amount = el('span', { className: 'hero-count' });
  const caption = el('span', { className: 'hero-caption' });
  const begin = el('button', { type: 'button', className: 'review-hero' },
    el('span', { className: 'calendar-mark', 'aria-hidden': 'true' }),
    el('span', { className: 'hero-copy' }, title, amount, caption));
  const upcoming = el('p', { className: 'review-upcoming' });
  function updateCount() {
    ctx.reviewFolder = filter.value;
    const time = new Date();
    const count = photos.filter(photo => reviewIsDue(photo, time, filter.value)).length;
    amount.replaceChildren(el('strong', {}, String(count)), '枚');
    caption.textContent = count ? '復習を始める' : '復習する写真はありません';
    upcoming.textContent = `今日このあと ${upcomingCount(photos, time, filter.value)}枚`;
    begin.disabled = count === 0;
  }
  begin.onclick = ctx.guard(async () => {
    const queue = duePhotos(await db.listPhotos(), new Date(), filter.value);
    if (!queue.length) {
      ctx.notify('今、復習する写真はありません。');
      ctx.refresh();
      return;
    }
    ctx.startReview(queue, folders.find(folder => folder.id === filter.value));
  });
  filter.onchange = updateCount;
  updateCount();
  scope.refreshAt(nextReviewRefresh(photos, now));

  const counts = new Map(folders.map(folder => [folder.id, { total: 0, due: 0 }]));
  for (const photo of photos) {
    const count = counts.get(photo.folderId);
    if (!count) continue;
    count.total++;
    if (reviewIsDue(photo, now)) count.due++;
  }
  const folio = folders.map(folder => {
    const count = counts.get(folder.id);
    return el('li', {}, el('a', { className: 'folder-row', href: `#folder/${folder.id}` },
      el('span', { className: 'folder-mark', 'aria-hidden': 'true' }),
      el('span', { className: 'folder-info' },
        el('strong', {}, folder.name), el('span', { className: 'muted' }, `${count.total}枚`)),
      el('span', { className: count.due ? 'pill due' : 'pill' }, `今の復習 ${count.due}枚`)));
  });
  const age = backupAge(last, localDay(now));
  return [
    el('section', { 'aria-label': '今の復習' }, begin, upcoming,
      el('div', { className: 'review-filter' }, labeled('復習するフォルダ', filter))),
    el('section', { className: 'section', 'aria-labelledby': 'folders-title' },
      el('div', { className: 'section-heading' }, el('h1', { id: 'folders-title' }, 'フォルダ'),
        button('フォルダを作る', ctx.guard(() => editFolder(ctx)), 'button small')),
      el('ul', { className: 'folder-list' }, folio)),
    el('section', { className: `backup-card${age.old ? ' old' : ''}` },
      el('div', {}, el('p', {}, age.text),
        age.old && description('そろそろ新しいバックアップを作っておくと安心です。')),
      link('バックアップ', '#settings', 'button small'))
  ];
}

function photoTitle(photo) {
  if (photo.source) {
    const name = photo.source.name.replace(/\.pdf$/i, '') || 'PDF';
    return `${name} ${photo.source.page}ページ`;
  }
  return formatDateTime(photo.fileModifiedAt ?? photo.importedAt);
}

function thumbnails(photos, scope) {
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
  const tiles = photos.map(photo => {
    const image = el('img', { alt: '', 'data-photo-id': photo.id, decoding: 'async' });
    observer.observe(image);
    const title = photo.note.split(/\r?\n/, 1)[0].trim() || photoTitle(photo);
    return el('li', {}, el('a', { className: 'tile', href: `#photo/${photo.id}` },
      el('span', { className: 'tile-image' }, image),
      el('span', { className: 'tile-title', title }, title)));
  });
  return el('ul', { className: 'tiles' }, tiles);
}

export async function renderFolder(ctx, id, scope) {
  const [all, folders] = await Promise.all([db.listPhotos(), db.listFolders()]);
  const folder = folders.find(record => record.id === id);
  if (!folder) return [heading('フォルダが見つかりません', 'ホームへ', '#home')];
  const photos = all.filter(photo => photo.folderId === id).sort((a, b) => a.importedAt - b.importedAt);
  const now = new Date();
  const dueCount = duePhotos(photos, now).length;
  scope.refreshAt(nextReviewRefresh(photos, now));
  const remove = ctx.guard(async () => {
    const defaultName = folders.find(record => record.id === db.DEFAULT_FOLDER).name;
    const choice = await dialog('フォルダを消しますか？',
      el('p', {}, `中の写真を一緒に消すか、「${defaultName}」に移すか選んでください。`), [
        ['やめる', ''], [`「${defaultName}」に移す`, 'move', 'button primary'],
        ['写真も一緒に消す', 'delete', 'button danger']
      ]);
    if (!choice) return;
    await db.deleteFolder(id, choice === 'move');
    ctx.notify('フォルダを消しました。');
    ctx.navigate('#home');
  });
  const start = ctx.guard(async () => {
    const queue = duePhotos(await db.listPhotos(), new Date(), id);
    if (queue.length) ctx.startReview(queue, folder);
    else ctx.refresh();
  });
  return [
    heading(folder.name, 'ホームへ', '#home'),
    el('div', { className: 'folder-summary' },
      description(`写真 ${photos.length}枚・今の復習 ${dueCount}枚`),
      el('div', { className: 'actions' },
        link('ここに取りこむ', `#import/${id}`, 'button primary'),
        dueCount > 0 && button('このフォルダを復習', start),
        button('名前を変える', ctx.guard(() => editFolder(ctx, folder))),
        id !== db.DEFAULT_FOLDER && button('フォルダを消す', remove, 'button danger'))),
    photos.length ? thumbnails(photos, scope) :
      el('p', { className: 'empty' }, 'このフォルダには、まだ写真がありません。')
  ];
}

export function photoSource(photo) {
  if (!photo.source) return null;
  return el('p', { className: 'source' },
    `元のPDF：${photo.source.name} ・ ${photo.source.page}ページ`);
}

export async function renderPhoto(ctx, id, scope) {
  const [photo, image, folders] = await Promise.all([db.getPhoto(id), db.getImage(id), db.listFolders()]);
  if (!photo || !image?.full) return [heading('写真が見つかりません', 'ホームへ', '#home')];
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
  const note = el('textarea', { value: photo.note, rows: 4, placeholder: '覚えたいことを書く' });
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
      ctx.notify('復習の設定を保存できませんでした。');
    } finally {
      toggle.disabled = false;
    }
  };
  const move = ctx.guard(async () => {
    const select = folderSelect(sortedFolders(folders), photo.folderId);
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
  return [
    heading(photoTitle(photo), 'フォルダへ', back),
    photoSource(photo),
    photoZoom(scope.blobUrl(image.full), '勉強用の写真'),
    el('section', { className: 'panel' }, labeled('メモ', note), noteStatus),
    el('section', { className: 'panel' }, due, memory,
      el('label', { className: 'toggle' }, toggle, '復習しない'),
      el('div', { className: 'actions' },
        button('別のフォルダへ移す', move), button('写真を消す', remove, 'button danger')))
  ];
}
