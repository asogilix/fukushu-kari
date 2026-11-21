import { APP_NAME } from './config.js';
import { renderFolder, renderHome, renderPhoto } from './library.js';
import { showPhotoViewer } from './photo-viewer.js';
import { el } from './ui.js';
import { beginReview, endReview, renderReview, renderSettings } from './workflow.js';

const main = document.querySelector('#main');
const notice = document.querySelector('#notice');
const operation = document.querySelector('#operation');
const operationText = document.querySelector('#operation-text');
const operationProgress = document.querySelector('#operation-progress');
const navItems = [...document.querySelectorAll('[data-tab]')];
const screens = {
  home: renderHome, folder: renderFolder, photo: renderPhoto,
  review: (context, _id, scope) => renderReview(context, scope),
  settings: (context, _id, scope) => renderSettings(context, scope)
};
let renderVersion = 0;
let disposeView = () => {};
let noticeTimer;
let jobRunning = false;
let photoViewer;

function route() {
  const [page, id] = location.hash.slice(1).split('/');
  return [Object.hasOwn(screens, page) ? page : 'home', id];
}

function notify(message) {
  clearTimeout(noticeTimer);
  notice.hidden = false;
  notice.textContent = message;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
}

function failure(error) {
  if (error?.name === 'QuotaExceededError') return '空き容量が足りません。';
  return '操作を完了できませんでした。もう一度お試しください。';
}

function guard(work) {
  return async (...args) => {
    try {
      return await work(...args);
    } catch (error) {
      notify(failure(error));
    }
  };
}

async function runJob(message, work) {
  if (jobRunning) {
    notify('今の作業が終わるまでお待ちください。');
    return;
  }
  jobRunning = true;
  function progress(value, total, text) {
    operationText.textContent = text;
    if (total > 0) {
      operationProgress.max = total;
      operationProgress.value = value;
    } else {
      operationProgress.removeAttribute('value');
    }
  }
  progress(null, null, message);
  operation.hidden = false;
  try {
    await work(progress, () => { operation.hidden = true; });
  } catch (error) {
    notify(failure(error));
  } finally {
    operation.hidden = true;
    jobRunning = false;
  }
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function closePhotoViewer() {
  if (!photoViewer || photoViewer.closing) return;
  photoViewer.closing = true;
  history.back();
}

function openPhotoViewer(options) {
  if (photoViewer || history.state?.photoViewer) return;
  const origin = location.href;
  const view = showPhotoViewer(options, closePhotoViewer);
  try {
    // Give the system Back gesture one same-URL entry to leave before leaving the photo page.
    history.pushState({ photoViewer: true }, '');
  } catch (error) {
    view.close();
    notify(failure(error));
    return;
  }
  photoViewer = { view, origin, photoId: options.photoId };
}

function disposePhotoViewer() {
  const active = photoViewer;
  photoViewer = undefined;
  return active.view.close();
}

const ctx = {
  notify, guard, runJob, navigate, openPhotoViewer,
  installed: navigator.standalone === true ||
    matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches,
  installPrompt: null,
  startReview(photos, folder) {
    beginReview(photos, folder);
    navigate('#review');
  },
  refresh: () => render(),
  refreshLibrary() {
    if (['home', 'folder'].includes(route()[0])) render();
  }
};

async function render(navigated = false) {
  if (photoViewer && !navigated) {
    photoViewer.refresh = true;
    closePhotoViewer();
    return;
  }
  if (photoViewer) disposePhotoViewer();
  disposeView();
  const version = ++renderVersion;
  const cleanups = [];
  const current = () => version === renderVersion;
  function onLeave(cleanup) {
    if (current()) cleanups.push(cleanup);
    else cleanup();
  }
  disposeView = () => cleanups.forEach(cleanup => cleanup());
  const scope = {
    current, onLeave,
    blobUrl(blob) {
      const url = URL.createObjectURL(blob);
      onLeave(() => URL.revokeObjectURL(url));
      return url;
    },
    listen(node, event, listener) {
      node.addEventListener(event, listener);
      onLeave(() => node.removeEventListener(event, listener));
    },
    refreshAt(time) {
      if (!current()) return;
      const check = () => {
        if (current() && !document.hidden && Date.now() >= time) render();
      };
      const timer = setTimeout(check, Math.max(0, time - Date.now()));
      onLeave(() => clearTimeout(timer));
      scope.listen(document, 'visibilitychange', check);
      scope.listen(window, 'focus', check);
    }
  };
  const [page, id] = route();
  if (page !== 'review') endReview();
  main.dataset.page = page;
  if (navigated) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close('');
    main.replaceChildren(el('p', { className: 'empty' }, '開いています。'));
    window.scrollTo(0, 0);
  }
  try {
    const children = await screens[page](ctx, id, scope);
    if (!current()) return;
    main.replaceChildren(...children.filter(Boolean));
    if (page === 'review') window.scrollTo(0, 0);
    if (navigated || page === 'review') {
      const title = main.querySelector('h1');
      if (title) {
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
    }
  } catch (error) {
    if (!current()) return;
    main.replaceChildren(el('p', { className: 'empty' }, failure(error)));
  }
  const tab = page === 'settings' ? 'settings' : 'home';
  for (const item of navItems) {
    if (item.dataset.tab === tab) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

document.title = APP_NAME;
document.querySelector('#app-name').textContent = APP_NAME;
window.addEventListener('popstate', () => {
  if (history.state?.photoViewer) {
    // A closed viewer's entry can still be reached by Forward.
    history.back();
    return;
  }
  if (!photoViewer) return;
  const { origin, photoId, refresh } = photoViewer;
  const lastId = disposePhotoViewer();
  if (location.href !== origin) return;
  if (lastId !== photoId) {
    history.replaceState(history.state, '', `#photo/${lastId}`);
    render(true);
  } else if (refresh) render();
});
window.addEventListener('hashchange', () => {
  if (!history.state?.photoViewer) render(true);
});
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  ctx.installPrompt = event;
});
window.addEventListener('appinstalled', () => {
  ctx.installed = true;
  ctx.installPrompt = null;
});
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
}
if (history.state?.photoViewer) history.back();
render();
