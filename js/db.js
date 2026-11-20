import { answerReview, migrateLegacyPhoto, RETENTION_SETTING, reviewIsDue } from './review.js';

export const DEFAULT_FOLDER = 'unfiled';
let opening;

function openDatabase() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('review-photo-album', 2);
      request.onupgradeneeded = ({ oldVersion }) => {
        const db = request.result;
        if (oldVersion === 0) {
          for (const name of ['folders', 'photos', 'images', 'settings']) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
          request.transaction.objectStore('photos').createIndex('importOrder', 'importedAt');
          request.transaction.objectStore('folders').add({
            id: DEFAULT_FOLDER, name: '未分類', createdAt: 0
          });
        }
        db.createObjectStore('reviewLogs', { keyPath: 'id' }).createIndex('photoId', 'photoId');
        if (oldVersion === 1) {
          const now = new Date();
          const scan = request.transaction.objectStore('photos').openCursor();
          scan.onsuccess = () => {
            const cursor = scan.result;
            if (!cursor) return;
            cursor.update(migrateLegacyPhoto(cursor.value, now));
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('ほかの画面を閉じてから、もう一度開いてください。'));
    }).catch(error => {
      opening = undefined;
      throw error;
    });
  }
  return opening;
}

async function run(names, mode, start) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, mode);
    let value;
    let failure;
    const capture = request => {
      request.onsuccess = () => { value = request.result; };
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(failure ?? transaction.error);
    try {
      start(transaction, capture);
    } catch (error) {
      failure = error;
      transaction.abort();
    }
  });
}

function read(store, id) {
  return run([store], 'readonly', (tx, capture) => {
    const table = tx.objectStore(store);
    capture(id === undefined ? table.getAll() : table.get(id));
  });
}

function put(store, record) {
  return run([store], 'readwrite', tx => tx.objectStore(store).put(record));
}

export const listFolders = () => read('folders');
export const listPhotos = () => read('photos');
export const getPhoto = id => read('photos', id);
export const getImage = id => read('images', id);
export const getSetting = async id => (await read('settings', id))?.value;
export const setSetting = (id, value) => put('settings', { id, value });
export const saveFolder = folder => put('folders', folder);

export function savePhoto(photo, image) {
  return run(['folders', 'photos', 'images'], 'readwrite', tx => {
    const photos = tx.objectStore('photos');
    const folder = tx.objectStore('folders').get(photo.folderId);
    const latest = photos.index('importOrder').openKeyCursor(null, 'prev');
    latest.onsuccess = () => {
      photos.add({
        ...photo, folderId: folder.result ? photo.folderId : DEFAULT_FOLDER,
        importedAt: Math.max(photo.importedAt, (latest.result?.key ?? 0) + 1)
      });
      tx.objectStore('images').add({ id: photo.id, ...image });
    };
  });
}

export function updatePhoto(id, changes) {
  return run(['photos', 'folders'], 'readwrite', tx => {
    const photos = tx.objectStore('photos');
    const find = photos.get(id);
    find.onsuccess = () => {
      if (!find.result) return;
      const patch = typeof changes === 'function' ? changes(find.result) : changes;
      if (!patch.folderId) {
        photos.put({ ...find.result, ...patch });
        return;
      }
      const folder = tx.objectStore('folders').get(patch.folderId);
      folder.onsuccess = () => {
        photos.put({ ...find.result, ...patch, folderId: folder.result ? patch.folderId : DEFAULT_FOLDER });
      };
    };
  });
}

export function recordReview(photo, answer, now, folderId) {
  return run(['photos', 'reviewLogs', 'settings'], 'readwrite', (tx, capture) => {
    const photos = tx.objectStore('photos');
    const setting = tx.objectStore('settings').get(RETENTION_SETTING);
    const find = photos.get(photo.id);
    find.onsuccess = () => {
      const latest = find.result;
      if (!latest || !reviewIsDue(latest, now, folderId)) return;
      if (latest.card.reps !== photo.card.reps || latest.card.last_review !== photo.card.last_review ||
          latest.card.due !== photo.card.due) return;
      const { card, log } = answerReview(latest.card, answer, now, setting.result?.value);
      if (!log) return;
      photos.put({ ...latest, card });
      capture(tx.objectStore('reviewLogs').add({ id: crypto.randomUUID(), photoId: photo.id, ...log }));
    };
  });
}

function deleteReviewLogs(tx, photoId) {
  const logs = tx.objectStore('reviewLogs');
  const scan = logs.index('photoId').openKeyCursor(photoId);
  scan.onsuccess = () => {
    const cursor = scan.result;
    if (!cursor) return;
    logs.delete(cursor.primaryKey);
    cursor.continue();
  };
}

export function deletePhoto(id) {
  return run(['photos', 'images', 'reviewLogs'], 'readwrite', tx => {
    tx.objectStore('photos').delete(id);
    tx.objectStore('images').delete(id);
    deleteReviewLogs(tx, id);
  });
}

export function deleteFolder(id, keepPhotos) {
  if (id === DEFAULT_FOLDER) throw new Error('このフォルダは消せません。');
  return run(['folders', 'photos', 'images', 'reviewLogs'], 'readwrite', tx => {
    const photos = tx.objectStore('photos');
    const images = tx.objectStore('images');
    const scan = photos.openCursor();
    scan.onsuccess = () => {
      const cursor = scan.result;
      if (!cursor) return;
      const photo = cursor.value;
      if (photo.folderId === id) {
        if (keepPhotos) {
          cursor.update({ ...photo, folderId: DEFAULT_FOLDER });
        } else {
          cursor.delete();
          images.delete(photo.id);
          deleteReviewLogs(tx, photo.id);
        }
      }
      cursor.continue();
    };
    tx.objectStore('folders').delete(id);
  });
}

export async function backupSnapshot() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['folders', 'photos', 'images', 'reviewLogs'], 'readonly');
    const folders = tx.objectStore('folders').getAll();
    const photos = tx.objectStore('photos').getAll();
    // IndexedDB returns Blob handles. The image bytes are read by ZIP streams.
    const images = tx.objectStore('images').getAll();
    const reviewLogs = tx.objectStore('reviewLogs').getAll();
    tx.oncomplete = () => resolve({
      folders: folders.result, photos: photos.result, reviewLogs: reviewLogs.result,
      images: new Map(images.result.map(image => [image.id, image]))
    });
    tx.onabort = () => reject(tx.error);
  });
}

export function restoreSnapshot({ folders, photos, images, reviewLogs }) {
  return run(['folders', 'photos', 'images', 'reviewLogs'], 'readwrite', tx => {
    const folderStore = tx.objectStore('folders');
    const photoStore = tx.objectStore('photos');
    const imageStore = tx.objectStore('images');
    for (const folder of folders) folderStore.put(folder);
    for (const photo of photos) photoStore.put(photo);
    for (const image of images.values()) imageStore.put(image);
    if (!photos.length) return;
    const restoredIds = new Set(photos.map(photo => photo.id));
    const logStore = tx.objectStore('reviewLogs');
    const scan = logStore.openCursor();
    scan.onsuccess = () => {
      const cursor = scan.result;
      if (!cursor) {
        for (const log of reviewLogs) logStore.add(log);
        return;
      }
      if (restoredIds.has(cursor.value.photoId)) cursor.delete();
      cursor.continue();
    };
  });
}
