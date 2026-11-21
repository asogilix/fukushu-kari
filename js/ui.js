import { folderTree } from './folders.js';
import { normalizePhotoTags, TAGS } from './photo-options.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name.includes('-')) node.setAttribute(name, value);
    else node[name] = value;
  }
  node.append(...children.flat(Infinity).filter(child => child != null && child !== false));
  return node;
}

export function button(text, onClick, className = 'button') {
  return el('button', { type: 'button', className, onclick: onClick }, text);
}

export function link(text, href, className = 'button') {
  return el('a', { href, className }, text);
}

export function labeled(text, input) {
  return el('label', { className: 'field' }, el('span', {}, text), input);
}

export function folderSelect(folders, selected) {
  const select = el('select');
  for (const { folder, children } of folderTree(folders)) {
    select.add(el('option', { value: folder.id }, folder.name));
    for (const child of children) {
      select.add(el('option', { value: child.id }, `${folder.name} › ${child.name}`));
    }
  }
  if (selected !== undefined) select.value = selected;
  if (select.selectedIndex === -1) select.selectedIndex = 0;
  return select;
}

export function heading(title, backText, backUrl) {
  const back = backUrl && link(backText, backUrl, 'back-link');
  return el('div', { className: 'page-heading' }, back, el('h1', {}, title));
}

export function description(text) {
  return el('p', { className: 'muted' }, text);
}

export function formatDateTime(value, { withTime = true, withYear = false } = {}) {
  const date = new Date(value);
  const year = withYear ? `${date.getFullYear()}年` : '';
  const time = withTime ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
  return `${year}${date.getMonth() + 1}月${date.getDate()}日${time}`;
}

export function dialog(title, body, choices, className = '') {
  const element = document.querySelector('#dialog');
  if (element.open) return Promise.resolve('');
  element.className = className;
  const form = el('form', { method: 'dialog' },
    el('h2', { id: 'dialog-title' }, title), body,
    el('div', { className: 'dialog-actions' }, choices.map(([text, value, style]) =>
      value ? el('button', { type: 'submit', value, className: style ?? 'button' }, text) :
        button(text, () => element.close(''), style))));
  element.replaceChildren(form);
  element.returnValue = '';
  return new Promise(resolve => {
    element.addEventListener('close', () => resolve(element.returnValue), { once: true });
    element.showModal();
  });
}

export function actionSheet(title, actions) {
  const sheet = document.querySelector('#action-sheet');
  if (sheet.open) return;
  const close = () => sheet.close();
  const items = actions.map(({ label, run, disabled = false, danger, current }) =>
    el('button', {
      type: 'button', className: danger ? 'sheet-action danger' : 'sheet-action', disabled,
      ...(current ? { 'aria-current': 'true' } : {}),
      onclick() {
        close();
        run();
      }
    }, label, current && el('span', { 'aria-hidden': 'true' }, ' ✓')));
  sheet.replaceChildren(el('h2', { id: 'sheet-title' }, title), ...items,
    button('閉じる', close, 'button sheet-close'));
  sheet.showModal();
}

export function tagDot({ id }) {
  return el('span', { className: `tag-dot tag-${id}`, 'aria-hidden': 'true' });
}

export function photoTagButtons(initialTags, change) {
  let tags = normalizePhotoTags(initialTags);
  let pending = Promise.resolve();
  const group = el('div', { className: 'tag-buttons', role: 'group', 'aria-label': '写真の印' });
  const controls = TAGS.map(tag => {
    const control = button('', () => {
      pending = pending.then(async () => {
        const changed = await change(tag.id, tags);
        if (changed) {
          tags = changed;
          update();
        }
      });
    }, 'button tag-button');
    control.setAttribute('aria-label', `${tag.color}の印`);
    control.append(tagDot(tag));
    return control;
  });
  function update() {
    controls.forEach((control, index) => control.setAttribute('aria-pressed', String(tags.includes(TAGS[index].id))));
  }
  update();
  group.append(...controls);
  return group;
}

export function photoSource(photo) {
  if (!photo.source) return null;
  return el('p', { className: 'source' },
    `元のPDF：${photo.source.name} ・ ${photo.source.page}ページ`);
}

export function photoPreview(url, openViewer) {
  const preview = button('', openViewer, 'photo-preview');
  preview.setAttribute('aria-label', '写真を全画面で見る');
  preview.setAttribute('aria-haspopup', 'dialog');
  preview.append(el('img', { src: url, alt: '' }),
    el('span', { className: 'photo-preview-label', 'aria-hidden': 'true' }, '拡大'));
  return preview;
}
