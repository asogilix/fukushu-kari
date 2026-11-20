import { APP_NAME } from './config.js';
import { DEFAULT_FOLDER } from './db.js';
import { renderFolder, renderHome, renderPhoto } from './library.js';
import { el } from './ui.js';
import { beginReview, renderImport, renderReview, renderSettings } from './workflow.js';

const main = document.querySelector('#main');
const notice = document.querySelector('#notice');
const operation = document.querySelector('#operation');
const operationText = document.querySelector('#operation-text');
const operationProgress = document.querySelector('#operation-progress');
const navItems = [...document.querySelectorAll('[data-tab]')];
const screens = {
  home: renderHome, folder: renderFolder, photo: renderPhoto, import: renderImport,
  review: (context, _id, scope) => renderReview(context, scope),
  settings: (context, _id, scope) => renderSettings(context, scope)
};
let renderVersion = 0;
let disposeView = () => {};
let noticeTimer;
let jobRunning = false;

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
    await work(progress);
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

const ctx = {
  notify, guard, runJob, navigate,
  reviewFolder: '', importFolder: DEFAULT_FOLDER,
  installed: matchMedia('(display-mode: standalone)').matches,
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
  main.dataset.page = page;
  if (navigated) {
    const dialog = document.querySelector('#dialog');
    if (dialog.open) dialog.close('');
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
  const tab = ['home', 'folder', 'photo', 'review'].includes(page) ? 'home' : page;
  for (const item of navItems) {
    if (item.dataset.tab === tab) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

document.title = APP_NAME;
document.querySelector('#app-name').textContent = APP_NAME;
window.addEventListener('hashchange', () => render(true));
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
render();
