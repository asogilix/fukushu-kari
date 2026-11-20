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

export function folderSelect(folders, selected, all = false) {
  const select = el('select');
  if (all) select.add(el('option', { value: '' }, 'すべてのフォルダ'));
  for (const { id, name } of folders) select.add(el('option', { value: id }, name));
  select.value = selected;
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

export function dialog(title, body, choices) {
  const element = document.querySelector('#dialog');
  if (element.open) return Promise.resolve('');
  const form = el('form', { method: 'dialog' },
    el('h2', { id: 'dialog-title' }, title), body,
    el('div', { className: 'dialog-actions' }, choices.map(([text, value, style]) =>
      el('button', { type: 'submit', value, className: style ?? 'button', formNoValidate: !value }, text))));
  element.replaceChildren(form);
  element.returnValue = '';
  return new Promise(resolve => {
    element.addEventListener('close', () => resolve(element.returnValue), { once: true });
    element.showModal();
  });
}

export function photoZoom(url, alt) {
  const image = el('img', { src: url, alt, draggable: false });
  const frame = el('div', { className: 'photo-frame' }, image);
  const pointers = new Map();
  let scale = 1;
  let x = 0;
  let y = 0;
  const minus = button('縮小', () => zoom(scale / 1.5), 'button small');
  const plus = button('拡大', () => zoom(scale * 1.5), 'button small');

  function update() {
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    const fit = image.naturalWidth
      ? Math.min(w / image.naturalWidth, h / image.naturalHeight) : 0;
    const limitX = Math.max(0, (fit * image.naturalWidth * scale - w) / 2);
    const limitY = Math.max(0, (fit * image.naturalHeight * scale - h) / 2);
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    frame.classList.toggle('zoomed', scale > 1);
    minus.disabled = scale <= 1;
    plus.disabled = scale >= 5;
  }

  function zoom(next, centerX = 0, centerY = 0) {
    const clamped = Math.max(1, Math.min(5, next));
    const change = clamped / scale;
    x = centerX + (x - centerX) * change;
    y = centerY + (y - centerY) * change;
    scale = clamped;
    update();
  }

  const point = event => ({ x: event.clientX, y: event.clientY });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  frame.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    pointers.set(event.pointerId, point(event));
    frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', event => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const after = point(event);
    pointers.set(event.pointerId, after);
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    if (!other) {
      if (scale > 1) {
        x += after.x - before.x;
        y += after.y - before.y;
        update();
      }
      return;
    }
    const rect = frame.getBoundingClientRect();
    x += (after.x - before.x) / 2;
    y += (after.y - before.y) / 2;
    zoom(scale * distance(after, other) / Math.max(1, distance(before, other)),
      (after.x + other.x - rect.width) / 2 - rect.left,
      (after.y + other.y - rect.height) / 2 - rect.top);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    frame.addEventListener(event, pointer => pointers.delete(pointer.pointerId));
  }
  image.addEventListener('load', update);
  update();
  return el('div', { className: 'viewer' }, frame, el('div', { className: 'zoom-actions' }, minus, plus));
}
