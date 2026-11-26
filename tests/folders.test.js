import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBackup, openBackup } from '../js/backup.js';
import { folderCounts, folderLocations, folderMenuItems, folderTree } from '../js/folders.js';
import { duePhotos, newReview } from '../js/review.js';

// Node does not provide IndexedDB. This double runs the requests and cursors used
// by the folder operations and commits their writes when the transaction completes.
async function openAlbum(t, oldVersion = 0, initial = {}) {
  const stores = new Map(Object.entries(initial).map(([name, records]) =>
    [name, new Map(records.map(record => [record.id, record]))]));
  function transaction(names) {
    const tables = new Map(names.map(name => [name, new Map(stores.get(name))]));
    const tasks = [];
    let aborted = false;
    function request(getResult, result = {}) {
      tasks.push(() => {
        result.result = getResult();
        result.onsuccess?.();
      });
      return result;
    }
    const tx = {
      abort() { aborted = true; },
      objectStore(name) {
        const table = tables.get(name);
        assert.ok(table, name);
        function scan(matches = () => true) {
          const cursorRequest = {};
          let keys;
          function step() {
            return request(() => {
              keys ??= [...table.keys()].filter(key => matches(table.get(key)));
              const key = keys.shift();
              return key === undefined ? null : {
                primaryKey: key, value: table.get(key),
                update: value => request(() => table.set(key, value)),
                delete: () => request(() => table.delete(key)),
                continue: step
              };
            }, cursorRequest);
          }
          return step();
        }
        return {
          get: key => request(() => table.get(key)),
          getAll: () => request(() => [...table.values()]),
          add: value => request(() => {
            assert.ok(!table.has(value.id));
            table.set(value.id, value);
            return value.id;
          }),
          put: value => request(() => table.set(value.id, value)),
          delete: key => request(() => table.delete(key)),
          openCursor: () => scan(),
          createIndex() {},
          index: key => ({ openKeyCursor: value => scan(record => record[key] === value) })
        };
      }
    };
    queueMicrotask(() => {
      while (tasks.length && !aborted) tasks.shift()();
      if (aborted) return tx.onabort?.();
      for (const [name, table] of tables) stores.set(name, table);
      tx.oncomplete?.();
    });
    return { tx, tables };
  }
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, 'review-photo-album');
      assert.equal(version, 3);
      const request = {};
      queueMicrotask(() => {
        const { tx, tables } = transaction([...stores.keys()]);
        request.result = {
          transaction: names => transaction(names).tx,
          createObjectStore(store) {
            assert.ok(!tables.has(store));
            tables.set(store, new Map());
            return tx.objectStore(store);
          }
        };
        request.transaction = tx;
        request.onupgradeneeded({ oldVersion });
        tx.oncomplete = () => request.onsuccess();
      });
      return request;
    }
  };
  t.after(() => { delete globalThis.indexedDB; });
  return import(`../js/db.js?test=${encodeURIComponent(t.name)}`);
}

const unfiled = { id: 'unfiled', name: '未分類', createdAt: 0, parentId: null };
const law = { id: 'law', name: '民法', createdAt: 1, parentId: null };
const general = { id: 'general', name: '総則', createdAt: 2, parentId: 'law' };
const other = { id: 'other', name: '別の科目', createdAt: 3, parentId: null };
const now = new Date(2026, 10, 21, 14);

function photo(id, folderId, due = now, excluded = false) {
  return { id, folderId, card: newReview(due), importedAt: +now, note: '', excluded, source: null };
}

async function setup(t, photos = [], reviewLogs = []) {
  const db = await openAlbum(t);
  await db.createFolder(law);
  await db.createFolder(general);
  await db.createFolder(other);
  const images = new Map(photos.map(({ id }) => [id, { id, full: new Blob([id]) }]));
  await db.restoreSnapshot({ folders: [], photos, images, reviewLogs });
  return db;
}

test('3段目、未分類の中、存在しない親の中にはフォルダを作れない', async t => {
  const db = await setup(t);
  for (const parentId of ['general', 'unfiled', 'missing']) {
    await assert.rejects(db.createFolder({ id: 'new', name: '新しいフォルダ', createdAt: 4, parentId }),
      /作れません/);
  }
  assert.deepEqual(await db.listFolders(), [unfiled, law, general, other]);
});

test('1段目の枚数と今の復習に、2段目の写真も含まれる', () => {
  const photos = [
    photo('direct', 'law'), photo('child', 'general'),
    photo('future', 'general', +now + 1_000), photo('excluded', 'general', now, true),
    photo('outside', 'other')
  ];
  const counts = folderCounts([unfiled, law, general, other], photos, now);
  assert.deepEqual(counts.get('law'), { total: 4, due: 2 });
  assert.deepEqual(counts.get('general'), { total: 3, due: 1 });
  assert.deepEqual(counts.get('other'), { total: 1, due: 1 });
});

test('作った順に2段で並べ、名前を変えた未分類もいちばん下に置く', () => {
  const contracts = { id: 'contracts', name: '契約', createdAt: 4, parentId: law.id };
  const renamed = { ...unfiled, name: '整理する写真' };
  const folders = [contracts, other, renamed, general, law];
  assert.deepEqual(folderTree(folders), [
    { folder: law, children: [general, contracts] },
    { folder: other, children: [] },
    { folder: renamed, children: [] }
  ]);
  assert.equal(folders[0], contracts);
  assert.deepEqual(folderTree([unfiled]), [{ folder: unfiled, children: [] }]);
});

test('作る場所にいちばん上と未分類以外の1段目を並べる', () => {
  assert.deepEqual(folderLocations([other, general, unfiled, law]), [
    { value: '', label: 'いちばん上' },
    { value: 'law', label: '民法の中' },
    { value: 'other', label: '別の科目の中' }
  ]);
  assert.deepEqual(folderLocations([unfiled]), [{ value: '', label: 'いちばん上' }]);
});

test('フォルダの段に合わせて操作を選び、消す操作を最後に置く', () => {
  const rename = { id: 'rename', label: '名前を変える' };
  const remove = { id: 'remove', label: 'フォルダを消す…', danger: true };
  const move = { id: 'move', label: '別のフォルダの中へ移す' };
  assert.deepEqual(folderMenuItems(unfiled, true), [rename]);
  assert.deepEqual(folderMenuItems(law, true),
    [rename, { id: 'create', label: 'この中にフォルダを作る' }, remove]);
  assert.deepEqual(folderMenuItems(general, true), [rename, { ...move, disabled: false }, remove]);
  assert.deepEqual(folderMenuItems(general, false), [rename, { ...move, disabled: true }, remove]);
});

test('2段目を消し、写真と復習の記録を残して親へ移す', async t => {
  const item = photo('child', 'general');
  const log = { id: 'log', photoId: item.id };
  const db = await setup(t, [item], [log]);
  await db.reorderPhotos('general', [item.id]);
  await db.deleteFolder('general', true);
  assert.deepEqual(await db.listFolders(), [unfiled, law, other]);
  assert.deepEqual(await db.getPhoto(item.id), { ...item, folderId: 'law' });
  assert.equal(await (await db.getImage(item.id)).full.text(), item.id);
  assert.deepEqual((await db.backupSnapshot()).reviewLogs, [log]);
});

test('1段目と中のフォルダを消し、両方の写真を未分類へ移す', async t => {
  const db = await setup(t, [photo('direct', 'law'), photo('child', 'general'), photo('outside', 'other')]);
  await db.deleteFolder('law', true);
  assert.deepEqual(await db.listFolders(), [unfiled, other]);
  assert.deepEqual((await db.listPhotos()).map(({ folderId }) => folderId), ['unfiled', 'unfiled', 'other']);
  assert.throws(() => db.deleteFolder('unfiled', true), /消せません/);
});

test('写真も一緒に消すと、中のフォルダの画像と復習の記録も消える', async t => {
  const db = await setup(t, [photo('direct', 'law'), photo('child', 'general'), photo('outside', 'other')],
    [{ id: 'child-log', photoId: 'child' }, { id: 'other-log', photoId: 'outside' }]);
  await db.deleteFolder('law', false);
  const snapshot = await db.backupSnapshot();
  assert.deepEqual(snapshot.folders, [unfiled, other]);
  assert.deepEqual(snapshot.photos.map(({ id }) => id), ['outside']);
  assert.deepEqual([...snapshot.images.keys()], ['outside']);
  assert.deepEqual(snapshot.reviewLogs.map(({ id }) => id), ['other-log']);
});

test('2段目を別の1段目に移すと、写真はそのままで新しい親から復習できる', async t => {
  const item = photo('child', 'general');
  const db = await setup(t, [item]);
  await assert.rejects(db.moveFolder('general', 'unfiled'), /移せません/);
  await assert.rejects(db.moveFolder('general', 'general'), /移せません/);
  await assert.rejects(db.moveFolder('law', 'other'), /移せません/);
  await db.moveFolder('general', 'other');
  assert.deepEqual(await db.listFolders(), [unfiled, law, { ...general, parentId: 'other' }, other]);
  assert.deepEqual(await db.getPhoto(item.id), item);
  assert.equal(await db.recordReview(item, 'remembered', now, 'law'), undefined);
  assert.ok(await db.recordReview(item, 'remembered', now, 'other'));
  assert.deepEqual(duePhotos(await db.listPhotos(), now), []);
});

test('版1と版2のデータを開くと、親のないフォルダに空の親が入る', async t => {
  for (const oldVersion of [1, 2]) {
    await t.test(`版${oldVersion}`, async subtest => {
      const folders = [unfiled, law].map(({ parentId, ...folder }) => folder);
      const db = await openAlbum(subtest, oldVersion, {
        folders, photos: [], images: [], settings: [], ...(oldVersion === 2 && { reviewLogs: [] })
      });
      assert.deepEqual(await db.listFolders(), [unfiled, law]);
      assert.deepEqual((await db.backupSnapshot()).reviewLogs, []);
    });
  }
});

test('バックアップの上書きで3段目になりかけた既存のフォルダを1段目に戻す', async t => {
  const item = photo('child', 'general');
  const db = await setup(t, [item]);
  await db.restoreSnapshot({
    folders: [unfiled, { ...law, parentId: 'other' }, other], photos: [], images: new Map(), reviewLogs: []
  });
  assert.deepEqual(await db.listFolders(), [
    unfiled, { ...law, parentId: 'other' }, { ...general, parentId: null }, other
  ]);
  assert.deepEqual(await db.getPhoto(item.id), item);
});

test('版3の印のない写真に、メモや復習の記録を保ったまま印をつけ外しできる', async t => {
  const item = { ...photo('old', 'law'), note: '見直す' };
  const log = { id: 'log', photoId: item.id };
  const db = await openAlbum(t, 3, {
    folders: [unfiled, law], photos: [item], images: [], settings: [], reviewLogs: [log]
  });
  assert.deepEqual(await db.getPhoto(item.id), item);
  assert.deepEqual(await db.toggleStoredPhotoTag(item.id, 'alert'), ['alert']);
  assert.deepEqual(await db.toggleStoredPhotoTag(item.id, 'star'), ['star', 'alert']);
  assert.deepEqual(await db.toggleStoredPhotoTag(item.id, 'alert'), ['star']);
  assert.deepEqual(await db.getPhoto(item.id), { ...item, tags: ['star'] });
  assert.deepEqual((await db.backupSnapshot()).reviewLogs, [log]);
});

test('保存済みの due は古い順に戻り、ほかのせっていは保つ', async t => {
  const db = await setup(t, []);
  await db.setSetting('photoPreferences', { sort: 'due', filter: 'alert', importNote: true });
  assert.deepEqual(await db.getPhotoPreferences(), { sort: 'oldest', filter: 'alert', importNote: true });
});

test('フォルダ内の写真に順番をつけ、別のフォルダへ移した写真の順番は消す', async t => {
  const first = photo('first', 'law');
  const second = photo('second', 'law');
  const outside = { ...photo('outside', 'general'), position: 2 };
  const db = await setup(t, [first, second, outside]);
  await db.updatePhotoPreferences({ sort: 'newest', importNote: true });
  await assert.rejects(db.reorderPhotos('law', ['second', 'outside']), /一覧が変わりました/);
  assert.deepEqual(await db.listPhotos(), [first, second, outside]);
  assert.equal((await db.getPhotoPreferences()).sort, 'newest');

  await db.reorderPhotos('law', ['second', 'first']);
  assert.deepEqual(await db.listPhotos(), [{ ...first, position: 1 }, { ...second, position: 0 }, outside]);
  assert.deepEqual(await db.getPhotoPreferences(), { sort: 'manual', filter: 'all', importNote: true });

  await db.updatePhoto(first.id, { folderId: 'law', note: '同じフォルダ' });
  assert.equal((await db.getPhoto(first.id)).position, 1);
  await db.updatePhoto(first.id, { folderId: 'general' });
  assert.deepEqual(await db.getPhoto(first.id), { ...first, folderId: 'general', note: '同じフォルダ' });
});

test('印とせっていを保存して復元し、せっていの項目がない古いバックアップでは現在のせっていを保つ', async t => {
  const item = { ...photo('one', 'law'), tags: ['alert'] };
  const db = await setup(t, [item]);
  assert.equal((await db.getPhotoPreferences()).importNote, false);
  await db.setSetting('photoPreferences', { tagNames: { star: '試験に出る' } });
  await db.updatePhotoPreferences({ sort: 'memory', filter: 'alert' });
  await db.updatePhotoPreferences({ importNote: true });
  const expected = { sort: 'memory', filter: 'alert', importNote: true };
  assert.deepEqual(await db.getPhotoPreferences(), expected);
  const backup = await makeBackup(await db.backupSnapshot());
  await db.toggleStoredPhotoTag(item.id, 'alert');
  await db.updatePhotoPreferences({ filter: 'all', importNote: false });
  await db.restoreSnapshot(await openBackup(backup));
  assert.deepEqual(await db.getPhotoPreferences(), expected);
  assert.deepEqual(await db.getPhoto(item.id), item);
  await db.restoreSnapshot({ folders: [], photos: [], images: new Map(), reviewLogs: [] });
  assert.deepEqual(await db.getPhotoPreferences(), expected);
});
