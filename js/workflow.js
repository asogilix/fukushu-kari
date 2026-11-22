import * as db from './db.js';
import { makeBackup, openBackup } from './backup.js';
import { folderIdsInBranch } from './folders.js';
import { readPdf, shrinkPhoto } from './import.js';
import { normalizePhotoTags, togglePhotoTag } from './photo-options.js';
import {
  daysBetween, duePhotos, localDay, MAX_RETENTION, MIN_RETENTION, newReview, RETENTION_SETTING, reviewIsDue,
  reviewRetention
} from './review.js';
import {
  actionSheet, button, description, dialog, el, formatDateTime, heading, labeled, link,
  photoPreview, photoSource, photoTagButtons
} from './ui.js';

let session;

export function beginReview(photos, folder) {
  session = { queue: photos.map(photo => photo.id), folder, answered: 0, forgotten: new Map() };
  return session;
}

export function endReview() {
  session = undefined;
}

export async function renderReview(ctx, scope) {
  if (!session) {
    const photos = await db.listPhotos();
    if (!scope.current()) return [];
    if (!session) beginReview(duePhotos(photos, new Date()));
  }
  const active = session;
  const folderId = active.folder?.id;
  const branch = folderId ? folderIdsInBranch(await db.listFolders(), folderId) : null;
  let photo;
  let image;
  while (active.queue.length && scope.current()) {
    const id = active.queue[0];
    [photo, image] = await Promise.all([db.getPhoto(id), db.getImage(id)]);
    if (!scope.current()) return [];
    if (photo && image?.full && (!branch || branch.has(photo.folderId)) && reviewIsDue(photo, Date.now())) break;
    active.queue.shift();
    photo = undefined;
  }
  const title = heading('今の復習', 'ほーむ\u2002へ', '#home');
  if (!photo) {
    let forgotten = 0;
    if (active.forgotten.size) {
      const latest = await Promise.all([...active.forgotten.keys()].map(db.getPhoto));
      if (!scope.current()) return [];
      forgotten = latest.filter(item =>
        item && !item.excluded && item.card.last_review === active.forgotten.get(item.id)).length;
    }
    return [
      title,
      el('section', { className: active.answered ? 'panel completion' : 'panel completion empty' },
        el('h2', {}, active.answered ? '今回の復習が終わりました' : '復習する写真はありません'),
        active.answered > 0 && description(`${active.answered}枚を復習しました。`),
        forgotten > 0 && description(`忘れた${forgotten}枚は、10分後にもう一度出ます`),
        link('ほーむ\u2002に戻る', '#home', 'button primary'))
    ];
  }

  const note = el('p', { className: 'review-note', id: 'review-note', hidden: true },
    photo.note || 'メモはありません。');
  const reveal = button('メモを見る', () => {
    note.hidden = !note.hidden;
    reveal.textContent = note.hidden ? 'メモを見る' : 'メモを隠す';
    reveal.setAttribute('aria-expanded', String(!note.hidden));
  });
  reveal.setAttribute('aria-expanded', 'false');
  reveal.setAttribute('aria-controls', 'review-note');
  const controls = el('fieldset', { className: 'review-actions', 'aria-label': '復習の答え' });
  const answer = value => async () => {
    if (controls.disabled) return;
    controls.disabled = true;
    try {
      if (value === 'later') {
        active.queue.push(active.queue.shift());
      } else {
        const reviewedAt = new Date();
        const saved = await db.recordReview(photo, value, reviewedAt, folderId);
        active.queue.shift();
        if (saved) {
          active.answered++;
          if (value === 'forgot') active.forgotten.set(photo.id, reviewedAt.toISOString());
        }
      }
      if (scope.current()) ctx.refresh();
    } catch {
      controls.disabled = false;
      ctx.notify('復習の結果を保存できませんでした。もう一度お試しください。');
    }
  };
  controls.append(
    button('忘れてた', answer('forgot'), 'button forgot'),
    button('覚えてた', answer('remembered'), 'button primary'),
    button('あとで', answer('later'), 'button later'));
  const url = scope.blobUrl(image.full);
  const openPreview = () => {
    if (scope.current()) ctx.openPhotoViewer({ photoId: photo.id, url, alt: '復習する写真' });
  };
  return [
    title,
    el('div', { className: 'review-meta' },
      description(active.folder?.name ?? 'すべてのフォルダ'),
      el('span', { className: 'pill due' }, `残り ${active.queue.length}枚`)),
    photoSource(photo),
    photoPreview(url, openPreview),
    el('section', { className: 'review-memory' },
      photoTagButtons(photo.tags, ctx.guard(tag => db.toggleStoredPhotoTag(photo.id, tag))), reveal, note),
    controls
  ];
}

function fileInput(options, onSelect) {
  const input = el('input', { type: 'file', hidden: true, ...options });
  input.onchange = () => {
    const files = Array.from(input.files);
    input.value = '';
    if (files.length) onSelect(files);
  };
  return input;
}

async function saveImported(image, folderId, source, fileModifiedAt) {
  const id = crypto.randomUUID();
  const importedAt = Date.now();
  const hasFileTime = Number.isSafeInteger(fileModifiedAt) && Number.isFinite(+new Date(fileModifiedAt));
  await db.savePhoto({
    id, folderId, source, importedAt,
    ...(hasFileTime ? { fileModifiedAt } : {}),
    note: '', excluded: false, card: newReview(importedAt)
  }, image);
  return id;
}

async function importedNote(photo, preview, index, total) {
  const note = el('textarea', { rows: 3, value: photo.note, placeholder: '覚えたいことを書く' });
  let tags = normalizePhotoTags(photo.tags);
  const marks = photoTagButtons(tags, (id, current) => {
    tags = togglePhotoTag(current, id);
    return tags;
  });
  const url = URL.createObjectURL(preview);
  const status = el('p', { className: 'import-note-error', role: 'status', hidden: true });
  const title = el('h2', { id: 'import-note-title', tabIndex: -1, autofocus: true }, '取りこんだ写真にメモ');
  const fields = el('fieldset', { className: 'import-note-fields' });
  const sheet = el('dialog', { className: 'action-sheet import-note-sheet', 'aria-labelledby': title.id });
  fields.append(
    el('img', { className: 'import-note-preview', src: url, alt: '取りこんだ写真' }),
    labeled('メモ', note), marks, status,
    el('div', { className: 'dialog-actions' },
      index + 1 < total && button('残りはあとで', () => sheet.close('')),
      button('あとで', () => sheet.close('next')),
      el('button', { className: 'button primary', type: 'submit' }, '保存')));
  const form = el('form', {}, title, total > 1 && description(`${index + 1}枚目／${total}枚`), fields);
  form.onsubmit = async event => {
    event.preventDefault();
    if (fields.disabled) return;
    fields.disabled = true;
    status.hidden = true;
    try {
      await db.updatePhoto(photo.id, { note: note.value, tags });
      if (sheet.open) sheet.close('next');
    } catch {
      status.textContent = 'メモと印を保存できませんでした。もう一度お試しください。';
      status.hidden = false;
    } finally {
      fields.disabled = false;
    }
  };
  sheet.oncancel = event => {
    if (fields.disabled) event.preventDefault();
  };
  sheet.append(form);
  document.body.append(sheet);
  try {
    const closed = new Promise(resolve => sheet.addEventListener('close', () => resolve(sheet.returnValue), { once: true }));
    sheet.showModal();
    return await closed;
  } finally {
    sheet.remove();
    URL.revokeObjectURL(url);
  }
}

function runImport(ctx, message, work) {
  return ctx.runJob(message, async (progress, hideProgress) => {
    const preferences = await db.getPhotoPreferences();
    const ids = [];
    const report = await work(progress, ids);
    hideProgress();
    if (preferences.importNote) {
      for (const [index, id] of ids.entries()) {
        const [photo, image] = await Promise.all([db.getPhoto(id), db.getImage(id)]);
        if (photo && image?.full && !await importedNote(photo, image.thumb ?? image.full, index, ids.length)) break;
      }
    }
    ctx.notify(report);
    ctx.refreshLibrary();
  });
}

export function folderImport(ctx, folderId) {
  const photos = files => {
    runImport(ctx, '写真を取りこんでいます。', async (progress, ids) => {
      for (const [index, file] of files.entries()) {
        progress(index, files.length, `写真を取りこんでいます（${index}／${files.length}枚）`);
        try {
          const image = await shrinkPhoto(file);
          ids.push(await saveImported(image, folderId, null, file.lastModified));
        } catch (error) {
          if (error.name === 'QuotaExceededError') break;
        }
      }
      const skipped = files.length - ids.length;
      const report = `${ids.length}枚を取りこみました。`;
      return skipped ? `${report}${skipped}枚は読みこみか保存ができませんでした。` : report;
    });
  };
  const camera = fileInput({ accept: 'image/*' }, photos);
  // capture is currently an attribute, even on browsers without a corresponding property.
  camera.setAttribute('capture', 'environment');
  const gallery = fileInput({ accept: 'image/*', multiple: true }, photos);
  const pdf = fileInput({ accept: 'application/pdf,.pdf' }, ctx.guard(async ([file]) => {
    const range = el('input', { type: 'text', placeholder: '例　3-10', maxLength: 32, autocomplete: 'off' });
    const choice = await dialog('PDF の取りこみ', [
      labeled('ページの範囲', range),
      description('空のままなら、すべてのページを取りこみます。')
    ], [['やめる', ''], ['取りこむ', 'import', 'button primary']]);
    if (!choice) return;
    runImport(ctx, 'PDF を開いています。', async (progress, ids) => {
      try {
        await readPdf(file, range.value, async (image, source) => {
          ids.push(await saveImported(image, folderId, source));
        }, (completed, total) => {
          progress(completed, total, `PDF を取りこんでいます（${completed}／${total}ページ）`);
        });
        return `${ids.length}枚を取りこみました。`;
      } catch (error) {
        let reason = 'PDF を読みこめませんでした。';
        if (error.message?.startsWith('ページ') || error.message?.startsWith('PDF を読むため')) {
          reason = error.message;
        } else if (error.name === 'PasswordException') {
          reason = 'パスワードで守られた PDF は取りこめません。';
        } else if (error.name === 'QuotaExceededError') {
          reason = '空き容量が足りません。';
        }
        return ids.length ? `${ids.length}枚を取りこみました。${reason}` : reason;
      }
    });
  }));
  const open = button('ここに取りこむ', () => actionSheet('ここに取りこむ', [
    { label: 'カメラで撮る', run: () => camera.click() },
    { label: 'スマホの写真を選ぶ', run: () => gallery.click() },
    { label: 'PDF を選ぶ', run: () => pdf.click() }
  ]));
  open.setAttribute('aria-haspopup', 'dialog');
  return [open, camera, gallery, pdf];
}

function storageAmount(bytes) {
  if (bytes / 1024 ** 3 >= 1) return `${(bytes / 1024 ** 3).toFixed(1)}ギガバイト`;
  return `${(bytes / 1024 ** 2).toFixed(1)}メガバイト`;
}

function backupDate(day) {
  return day ? formatDateTime(`${day}T00:00:00`, { withTime: false, withYear: true }) : 'まだありません';
}

export async function renderSettings(ctx, scope) {
  const [last, retention, preferences] = await Promise.all([
    db.getSetting('lastBackup'), db.getSetting(RETENTION_SETTING), db.getPhotoPreferences()
  ]);
  const importNote = el('input', { type: 'checkbox', checked: preferences.importNote });
  importNote.onchange = ctx.guard(async () => {
    const checked = importNote.checked;
    importNote.disabled = true;
    try {
      await db.updatePhotoPreferences({ importNote: checked });
    } catch (error) {
      importNote.checked = !checked;
      throw error;
    } finally {
      importNote.disabled = false;
    }
  });
  let savedGoal = String(Math.round(reviewRetention(retention) * 100));
  const goal = el('select');
  for (let percent = Math.round(MIN_RETENTION * 100); percent <= Math.round(MAX_RETENTION * 100); percent++) {
    goal.add(el('option', { value: String(percent) }, `${percent}%`));
  }
  goal.value = savedGoal;
  goal.onchange = ctx.guard(async () => {
    const next = goal.value;
    goal.disabled = true;
    try {
      await db.setSetting(RETENTION_SETTING, Number(next) / 100);
      savedGoal = next;
      ctx.notify('目標を保存しました。');
    } finally {
      goal.value = savedGoal;
      goal.disabled = false;
    }
  });
  const age = description(`最後のバックアップ：${backupDate(last)}`);
  const reminder = description('最後のバックアップから14日以上たっています。');
  reminder.hidden = !last || daysBetween(last, localDay()) < 14;
  const download = el('div', { className: 'download', hidden: true });
  let downloadUrl;
  let saving = false;
  function clearDownload() {
    const url = downloadUrl;
    if (!url) return;
    if (saving) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    else URL.revokeObjectURL(url);
    downloadUrl = undefined;
    saving = false;
  }
  scope.onLeave(clearDownload);
  const usage = el('p', { className: 'muted' }, '使っている容量を調べています。');
  const protection = el('p', { className: 'muted' }, '保存の\u2002せってい\u2002を調べています。');
  const persist = button('写真を消えにくくする', ctx.guard(async () => {
    const granted = await navigator.storage?.persist?.();
    ctx.notify(granted ? '写真を消えにくくする\u2002せってい\u2002が有効になりました。' : 'ブラウザから許可が得られませんでした。');
    await updateStorage();
  }));
  async function updateStorage() {
    const [estimate, persistent] = await Promise.allSettled([
      navigator.storage?.estimate?.(), navigator.storage?.persisted?.()
    ]);
    usage.textContent = Number.isFinite(estimate.value?.usage) ?
      `使っている容量の目安：${storageAmount(estimate.value.usage)}` : '使っている容量はわかりません。';
    protection.textContent = persistent.value ?
      '写真を消えにくくする\u2002せってい\u2002が有効です。' : '写真を消えにくくする\u2002せってい\u2002は有効になっていません。';
    persist.disabled = Boolean(persistent.value);
    persist.hidden = !navigator.storage?.persist;
  }
  updateStorage();
  const exportBackup = button('バックアップを作る', () => ctx.runJob('バックアップを作っています。', async progress => {
    const blob = await makeBackup(await db.backupSnapshot(), (done, total) =>
      progress(done, total, `バックアップを作っています（${done}／${total}件）`));
    if (!scope.current()) {
      ctx.notify('バックアップを保存するには、せってい\u2002で作り直してください。');
      return;
    }
    clearDownload();
    downloadUrl = URL.createObjectURL(blob);
    const save = link('ファイルを保存する', downloadUrl, 'button primary');
    save.download = `写真帳のバックアップ-${localDay()}.zip`;
    save.onclick = () => {
      saving = true;
      const today = localDay();
      db.setSetting('lastBackup', today).then(() => {
        age.textContent = `最後のバックアップ：${backupDate(today)}`;
        reminder.hidden = true;
        ctx.notify('バックアップの保存を始めました。');
      }).catch(() => ctx.notify('最後に保存した日を記録できませんでした。'));
    };
    download.replaceChildren(save);
    download.hidden = false;
    save.focus();
  }), 'button primary');
  const restore = fileInput({ accept: '.zip,application/zip' }, ctx.guard(async ([file]) => {
    const approved = await dialog('バックアップを読みこみますか？',
      el('p', {}, '今の写真帳に追加します。同じ写真やフォルダがある場合は、ファイルの内容で上書きします。一覧と取りこみの\u2002せってい\u2002も読みこみます。'),
      [['やめる', ''], ['読みこむ', 'restore', 'button primary']]);
    if (!approved) return;
    ctx.runJob('バックアップを調べています。', async progress => {
      try {
        const snapshot = await openBackup(file, (done, total) =>
          progress(done, total, `バックアップを調べています（${done}／${total}件）`));
        progress(null, null, '写真帳に保存しています。');
        await db.restoreSnapshot(snapshot);
        ctx.notify(`バックアップから${snapshot.photos.length}枚の写真を読みこみました。`);
        if (scope.current()) ctx.refresh();
        else ctx.refreshLibrary();
      } catch (error) {
        ctx.notify(error.name === 'QuotaExceededError' ? '空き容量が足りません。' :
          'バックアップを読みこめませんでした。この写真帳で作ったファイルか確かめてください。');
      }
    });
  }));

  const installState = el('div');
  const installSection = el('section', { className: 'panel' }, el('h2', {}, 'ホーム画面に追加'), installState);
  function showInstall() {
    installSection.hidden = ctx.installed;
    if (ctx.installed) return;
    const prompt = ctx.installPrompt;
    if (prompt) {
      installState.replaceChildren(button('ホーム画面に追加', ctx.guard(async () => {
        ctx.installPrompt = null;
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'accepted') ctx.installed = true;
        showInstall();
      }), 'button primary'));
    } else {
      installState.replaceChildren(description('ブラウザの右上のメニューから、スマホのホーム画面に追加します。'));
    }
  }
  showInstall();
  scope.listen(window, 'beforeinstallprompt', showInstall);
  scope.listen(window, 'appinstalled', showInstall);

  return [
    heading('せってい', 'ほーむ\u2002へ', '#home'),
    el('section', { className: 'panel' }, el('h2', {}, '取りこみ'),
      el('label', { className: 'toggle' }, importNote, '取りこんだ直後にメモ欄を出す')),
    el('section', { className: 'panel' }, el('h2', {}, '復習'), labeled('覚えている確率の目標', goal),
      description('高くすると、次の復習までの間隔が短くなります。次に答えたときから反映します。')),
    el('section', { className: 'panel' }, el('h2', {}, 'バックアップ'), age, reminder,
      description('写真、メモ、印、フォルダ、復習の予定と記録、一覧と取りこみの\u2002せってい\u2002をひとつのファイルにまとめます。'),
      el('div', { className: 'actions' }, exportBackup,
        button('バックアップを読みこむ', () => restore.click()), restore), download),
    el('section', { className: 'panel' }, el('h2', {}, 'スマホの保存容量'), usage, protection, persist),
    installSection
  ];
}
