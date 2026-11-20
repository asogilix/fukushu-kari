import * as db from './db.js';
import { makeBackup, openBackup } from './backup.js';
import { readPdf, shrinkPhoto } from './import.js';
import { backupAge, photoSource, sortedFolders } from './library.js';
import { localDay, MAX_RETENTION, MIN_RETENTION, newReview, RETENTION_SETTING, reviewIsDue, reviewRetention } from './review.js';
import { button, description, dialog, el, folderSelect, heading, labeled, link, photoZoom } from './ui.js';

let session;

export function beginReview(photos, folder) {
  session = { queue: photos.map(photo => photo.id), folder, answered: 0 };
}

export async function renderReview(ctx, scope) {
  const active = session;
  let photo;
  let image;
  while (active?.queue.length && scope.current()) {
    const id = active.queue[0];
    [photo, image] = await Promise.all([db.getPhoto(id), db.getImage(id)]);
    if (!scope.current()) return [];
    if (photo && image?.full && reviewIsDue(photo, Date.now(), active.folder?.id)) break;
    active.queue.shift();
    photo = undefined;
  }
  const title = heading('今の復習', 'ホームへ', '#home');
  if (!photo) return [
    title,
    el('section', { className: 'panel completion' },
      el('h2', {}, active?.answered ? '今回の復習が終わりました' : '復習する写真はありません'),
      active?.answered ? description(`${active.answered}枚を復習しました。`) : null,
      link('ホームに戻る', '#home', 'button primary'))
  ];

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
        const saved = await db.recordReview(photo, value, new Date(), active.folder?.id);
        active.queue.shift();
        if (saved) active.answered++;
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
  return [
    title,
    el('div', { className: 'review-meta' },
      description(active.folder?.name ?? 'すべてのフォルダ'),
      el('span', { className: 'pill due' }, `残り ${active.queue.length}枚`)),
    photoSource(photo),
    photoZoom(scope.blobUrl(image.full), '復習する写真'),
    el('section', { className: 'review-memory' }, reveal, note),
    controls
  ];
}

function filePicker(text, options, onSelect, className = 'button') {
  const input = el('input', { type: 'file', hidden: true, ...options });
  input.onchange = () => {
    const files = Array.from(input.files);
    input.value = '';
    if (files.length) onSelect(files);
  };
  return [button(text, () => input.click(), className), input];
}

function saveImported(image, folderId, source, fileModifiedAt) {
  const importedAt = Date.now();
  const hasFileTime = Number.isSafeInteger(fileModifiedAt) && Number.isFinite(+new Date(fileModifiedAt));
  return db.savePhoto({
    id: crypto.randomUUID(), folderId, source, importedAt,
    ...(hasFileTime ? { fileModifiedAt } : {}),
    note: '', excluded: false, card: newReview(importedAt)
  }, image);
}

export async function renderImport(ctx, id) {
  const folders = sortedFolders(await db.listFolders());
  const destination = folderSelect(folders, id || ctx.importFolder);
  const openFolder = link('取りこみ先のフォルダを開く', `#folder/${destination.value}`, 'back-link');
  destination.onchange = () => {
    ctx.importFolder = destination.value;
    openFolder.href = `#folder/${destination.value}`;
  };
  const photos = files => {
    const folderId = destination.value;
    ctx.runJob('写真を取りこんでいます。', async progress => {
      let imported = 0;
      for (const [index, file] of files.entries()) {
        progress(index, files.length, `写真を取りこんでいます（${index}／${files.length}枚）`);
        try {
          const image = await shrinkPhoto(file);
          await saveImported(image, folderId, null, file.lastModified);
          imported++;
        } catch (error) {
          if (error.name === 'QuotaExceededError') break;
        }
      }
      const skipped = files.length - imported;
      ctx.notify(skipped ? `${imported}枚を取りこみました。${skipped}枚は読みこみか保存ができませんでした。` :
        `${imported}枚を取りこみました。`);
      ctx.refreshLibrary();
    });
  };
  const camera = filePicker('カメラで撮る',
    { accept: 'image/*' }, photos, 'button primary');
  // capture is currently an attribute, even on browsers without a corresponding property.
  camera[1].setAttribute('capture', 'environment');
  const gallery = filePicker('スマホの写真を選ぶ', { accept: 'image/*', multiple: true }, photos);
  const range = el('input', { type: 'text', placeholder: '例　3-10', maxLength: 32, autocomplete: 'off' });
  const pdf = filePicker('PDF を選ぶ', { accept: 'application/pdf,.pdf' }, ([file]) => {
    const folderId = destination.value;
    const requested = range.value;
    ctx.runJob('PDF を開いています。', async progress => {
      let imported = 0;
      try {
        await readPdf(file, requested, async (image, source) => {
          await saveImported(image, folderId, source);
          imported++;
        }, (completed, total) => {
          progress(completed, total, `PDF を取りこんでいます（${completed}／${total}ページ）`);
        });
        ctx.notify(`${imported}ページを取りこみました。`);
      } catch (error) {
        let reason = 'PDF を読みこめませんでした。';
        if (error.message?.startsWith('ページ') || error.message?.startsWith('PDF を読むため')) {
          reason = error.message;
        } else if (error.name === 'PasswordException') {
          reason = 'パスワードで守られた PDF は取りこめません。';
        } else if (error.name === 'QuotaExceededError') {
          reason = '空き容量が足りません。';
        }
        ctx.notify(imported ? `${imported}ページを取りこみました。${reason}` : reason);
      }
      ctx.refreshLibrary();
    });
  });
  return [
    heading('取りこみ', 'ホームへ', '#home'),
    el('section', { className: 'panel' }, labeled('取りこみ先のフォルダ', destination), openFolder),
    el('section', { className: 'panel' }, el('h2', {}, '写真を取りこむ'),
      el('div', { className: 'actions' }, camera, gallery)),
    el('section', { className: 'panel' }, el('h2', {}, 'PDF を取りこむ'),
      labeled('ページの範囲', range),
      description('空のままなら、すべてのページを取りこみます。'),
      pdf)
  ];
}

function storageAmount(bytes) {
  if (bytes / 1024 ** 3 >= 1) return `${(bytes / 1024 ** 3).toFixed(1)}ギガバイト`;
  return `${(bytes / 1024 ** 2).toFixed(1)}メガバイト`;
}

export async function renderSettings(ctx, scope) {
  const [last, retention] = await Promise.all([db.getSetting('lastBackup'), db.getSetting(RETENTION_SETTING)]);
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
  const age = el('p', { className: 'muted' }, backupAge(last).text);
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
  const protection = el('p', { className: 'muted' }, '保存の設定を調べています。');
  const persist = button('写真を消えにくくする', ctx.guard(async () => {
    const granted = await navigator.storage?.persist?.();
    ctx.notify(granted ? '写真を消えにくくする設定が有効になりました。' : 'ブラウザから許可が得られませんでした。');
    await updateStorage();
  }));
  async function updateStorage() {
    const [estimate, persistent] = await Promise.allSettled([
      navigator.storage?.estimate?.(), navigator.storage?.persisted?.()
    ]);
    usage.textContent = Number.isFinite(estimate.value?.usage) ?
      `使っている容量の目安：${storageAmount(estimate.value.usage)}` : '使っている容量はわかりません。';
    protection.textContent = persistent.value ?
      '写真を消えにくくする設定が有効です。' : '写真を消えにくくする設定は有効になっていません。';
    persist.disabled = Boolean(persistent.value);
    persist.hidden = !navigator.storage?.persist;
  }
  updateStorage();
  const exportBackup = button('バックアップを作る', () => ctx.runJob('バックアップを作っています。', async progress => {
    const blob = await makeBackup(await db.backupSnapshot(), (done, total) =>
      progress(done, total, `バックアップを作っています（${done}／${total}件）`));
    if (!scope.current()) {
      ctx.notify('バックアップを保存するには、設定で作り直してください。');
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
        age.textContent = backupAge(today).text;
        ctx.notify('バックアップの保存を始めました。');
      }).catch(() => ctx.notify('最後に保存した日を記録できませんでした。'));
    };
    download.replaceChildren(save);
    download.hidden = false;
    save.focus();
  }), 'button primary');
  const restore = filePicker('バックアップを読みこむ', { accept: '.zip,application/zip' }, ctx.guard(async ([file]) => {
    const approved = await dialog('バックアップを読みこみますか？',
      el('p', {}, '今の写真帳に追加します。同じ写真やフォルダがある場合は、ファイルの内容で上書きします。'),
      [['やめる', ''], ['読みこむ', 'restore', 'button primary']]);
    if (!approved) return;
    ctx.runJob('バックアップを調べています。', async progress => {
      try {
        const snapshot = await openBackup(file, (done, total) =>
          progress(done, total, `バックアップを調べています（${done}／${total}件）`));
        progress(null, null, '写真帳に保存しています。');
        await db.restoreSnapshot(snapshot);
        ctx.notify(`バックアップから${snapshot.photos.length}枚の写真を読みこみました。`);
        await updateStorage();
        ctx.refreshLibrary();
      } catch (error) {
        ctx.notify(error.name === 'QuotaExceededError' ? '空き容量が足りません。' :
          'バックアップを読みこめませんでした。この写真帳で作ったファイルか確かめてください。');
      }
    });
  }));

  const installState = el('div');
  function showInstall() {
    const prompt = ctx.installPrompt;
    if (ctx.installed) {
      installState.replaceChildren(description('ホーム画面から写真帳を開けます。'));
    } else if (prompt) {
      installState.replaceChildren(button('ホーム画面に追加', ctx.guard(async () => {
        ctx.installPrompt = null;
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'accepted') ctx.installed = true;
        showInstall();
      }), 'button primary'));
    } else {
      installState.replaceChildren(description('ブラウザの右上のメニューから「ホーム画面に追加」を選びます。'));
    }
  }
  showInstall();
  scope.listen(window, 'beforeinstallprompt', showInstall);
  scope.listen(window, 'appinstalled', showInstall);

  return [
    heading('設定', 'ホームへ', '#home'),
    el('section', { className: 'panel' }, el('h2', {}, '復習'), labeled('覚えている確率の目標', goal),
      description('高くすると、次の復習までの間隔が短くなります。次に答えたときから反映します。')),
    el('section', { className: 'panel' }, el('h2', {}, 'バックアップ'), age,
      description('写真、メモ、フォルダ、復習の予定と記録をひとつのファイルにまとめます。'),
      el('div', { className: 'actions' }, exportBackup, restore), download),
    el('section', { className: 'panel' }, el('h2', {}, 'スマホの保存容量'), usage, protection, persist),
    el('section', { className: 'panel' }, el('h2', {}, 'ホーム画面に追加'), installState)
  ];
}
