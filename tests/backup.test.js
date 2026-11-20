import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBackup, openBackup } from '../js/backup.js';
import { answerReview, migrateLegacyPhoto, newReview } from '../js/review.js';
import { crc32, readZip, writeZip } from '../js/zip.js';

const legacy = {
  folders: [
    { id: 'unfiled', name: '未分類', createdAt: 0 },
    { id: 'law', name: '民法', createdAt: 1 }
  ],
  photos: [
    {
      id: 'photo-1', folderId: 'law', title: '条文集・7ページ',
      note: 'まず例外を確認する。\n次に要件を見る。', importedAt: 42, due: '2027-02-03',
      stage: 4, excluded: true, source: { name: '条文集.pdf', page: 7 }
    },
    {
      id: 'photo-2', folderId: 'unfiled', title: '参考書の写真',
      note: '', importedAt: 43, due: '2026-11-22', stage: 0, excluded: false, source: null
    }
  ],
  images: new Map([
    ['photo-1', {
      id: 'photo-1', full: new Blob([new Uint8Array([255, 216, 44, 255, 217])]),
      thumb: new Blob([new Uint8Array([255, 216, 22, 255, 217])])
    }],
    ['photo-2', { id: 'photo-2', full: new Blob([new Uint8Array([255, 216, 7, 255, 217])]) }]
  ])
};

const now = new Date(2026, 10, 21, 14);
const first = answerReview(newReview(now), 'remembered', new Date(+now + 3_600_000));
const second = answerReview(first.card, 'forgot', new Date(first.card.due));
const example = {
  folders: legacy.folders, images: legacy.images,
  photos: [
    { ...migrateLegacyPhoto(legacy.photos[0], now), card: second.card },
    { ...migrateLegacyPhoto(legacy.photos[1], now), fileModifiedAt: 24, card: newReview(now) }
  ],
  reviewLogs: [
    { id: 'log-1', photoId: 'photo-1', ...first.log },
    { id: 'log-2', photoId: 'photo-1', ...second.log }
  ]
};

test('標準の検査値と一致する', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('複数の Blob と日本語のファイル名を往復できる', async () => {
  const entries = [['写真/民法.jpg', new Blob([new Uint8Array([0, 255, 12])])],
    ['メモ.txt', new Blob(['復習します。'])]];
  const zip = await writeZip(entries);
  const unpacked = await readZip(zip);
  assert.deepEqual([...unpacked.keys()], entries.map(([name]) => name));
  for (const [name, original] of entries) {
    assert.deepEqual(await unpacked.get(name).bytes(), await original.bytes());
  }
});

test('バックアップでフォルダ、画像、メモ、復習状態と記録、PDFの出典を往復できる', async () => {
  const progress = [];
  const zip = await makeBackup(example, (done, total) => progress.push([done, total]));
  const restored = await openBackup(zip);
  assert.deepEqual(restored.folders, example.folders);
  assert.deepEqual(restored.photos, example.photos);
  assert.deepEqual(restored.reviewLogs, example.reviewLogs);
  const nextDue = new Date(second.card.due);
  assert.deepEqual(answerReview(restored.photos[0].card, 'remembered', nextDue),
    answerReview(example.photos[0].card, 'remembered', nextDue));
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  for (const [id, original] of example.images) {
    const image = restored.images.get(id);
    assert.equal(image.full.type, 'image/jpeg');
    assert.deepEqual(await image.full.bytes(), await original.full.bytes());
    assert.deepEqual(await image.thumb?.bytes(), await original.thumb?.bytes());
  }
});

test('最初の版のバックアップは読みこみ時点を期限にし、初回の復習として扱う', async () => {
  const zip = await writeZip([
    ['data.json', new Blob([JSON.stringify({ version: 1, folders: legacy.folders, photos: legacy.photos })])],
    ...Array.from(legacy.images, ([id, image]) => [`photos/${id}.jpg`, image.full])
  ]);
  const restored = await openBackup(zip, undefined, now);
  assert.deepEqual(restored.folders, legacy.folders);
  assert.deepEqual(restored.photos, legacy.photos.map(photo => migrateLegacyPhoto(photo, now)));
  assert.deepEqual(restored.reviewLogs, []);
  assert.equal(restored.photos[1].card.due, now.toISOString());
  assert.equal(restored.photos[1].card.last_review, null);
  assert.deepEqual(await restored.images.get('photo-1').full.bytes(), await legacy.images.get('photo-1').full.bytes());
});

test('カードの日時や復習の記録が壊れたバックアップは読みこまない', async () => {
  const badCard = { ...example.photos[0], card: { ...second.card, due: '2026-11-21' } };
  const badLog = { ...example.reviewLogs[0], photoId: 'missing' };
  for (const snapshot of [
    { ...example, photos: [badCard, example.photos[1]] },
    { ...example, reviewLogs: [badLog] },
    { ...example, reviewLogs: [example.reviewLogs[0], example.reviewLogs[0]] }
  ]) {
    const zip = await makeBackup(snapshot);
    await assert.rejects(() => openBackup(zip), /読みこめませんでした/);
  }
});

test('文章や画像が壊れたバックアップは読みこまない', async () => {
  const zip = await makeBackup(example);
  const bytes = await zip.bytes();
  bytes[30 + 'data.json'.length] ^= 1;
  await assert.rejects(() => openBackup(new Blob([bytes])), /壊れています/);
  await assert.rejects(() => openBackup(zip.slice(0, -1)), /壊れています/);
});

test('フォルダが空のバックアップも読みこめる', async () => {
  const empty = { folders: example.folders, photos: [], images: new Map(), reviewLogs: [] };
  assert.deepEqual(await openBackup(await makeBackup(empty)), empty);
});

test('数百枚の写真を一つのファイルで往復できる', async () => {
  const full = new Blob([new Uint8Array(100_000)]);
  const photos = Array.from({ length: 320 }, (_, index) => ({
    ...example.photos[0], id: `photo-${index}`, importedAt: index
  }));
  const images = new Map(photos.map(({ id }) => [id, { id, full }]));
  const restored = await openBackup(await makeBackup({ folders: example.folders, photos, images, reviewLogs: [] }));
  assert.deepEqual(restored.photos, photos);
  assert.equal(restored.images.size, 320);
  assert.equal(restored.images.get('photo-319').full.size, 100_000);
});
