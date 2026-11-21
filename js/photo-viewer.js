import { getImage } from './db.js';
import { adjacentIndex, clampZoom, doubleTapZoom, swipeDirection } from './photo-viewer-logic.js';
import { button, el } from './ui.js';

const TAP_DELAY = 280;
const TAP_SLOP = 8;
const FLING_WINDOW = 100;
const point = event => ({ x: event.clientX, y: event.clientY, time: event.timeStamp });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const translation = (x, y) => `translate3d(${x}px, ${y}px, 0)`;

export function showPhotoViewer({ photoId, url, alt, loadPhotoIds }, requestClose) {
  const track = el('div', { className: 'photo-viewer-track' });
  const stage = el('div', { className: 'photo-viewer-stage', tabIndex: -1 }, track);
  const counter = el('span', { className: 'photo-viewer-count', role: 'status', hidden: true });
  const closeButton = button('×', requestClose, 'photo-viewer-close');
  closeButton.autofocus = true;
  closeButton.setAttribute('aria-label', '閉じる');
  const toolbar = el('div', { className: 'photo-viewer-toolbar' }, counter, closeButton);
  const dialog = el('dialog', { className: 'photo-viewer', 'aria-label': '写真を全画面で見る' }, stage, toolbar);
  dialog.setAttribute('closedby', 'none');

  const slides = new Map();
  const pointers = new Map();
  let photoIds = [photoId];
  let index = 0;
  let scale = 1;
  let x = 0;
  let y = 0;
  let gesture;
  let pendingTap;
  let tapTimer;
  let motion;

  function addSlide(id) {
    const image = el('img', { alt, draggable: false, decoding: 'async' });
    const status = el('p', { className: 'photo-viewer-status' }, '写真を開いています。');
    const node = el('div', { className: 'photo-viewer-slide' }, image, status);
    const slide = { node, image };
    slides.set(id, slide);
    track.append(node);

    function failed() {
      if (slides.get(id) !== slide) return;
      status.textContent = '写真を開けませんでした。';
      image.removeAttribute('src');
    }

    async function load() {
      try {
        if (id === photoId) image.src = url;
        else {
          const record = await getImage(id);
          if (slides.get(id) !== slide) return;
          if (!record?.full) {
            failed();
            return;
          }
          slide.url = URL.createObjectURL(record.full);
          image.src = slide.url;
        }
        await image.decode();
        if (slides.get(id) !== slide) return;
        status.hidden = true;
        if (photoIds[index] === id) updateZoom();
      } catch {
        failed();
      }
    }
    load();
    return slide;
  }

  function removeSlide(id, slide) {
    slides.delete(id);
    slide.node.remove();
    slide.image.removeAttribute('src');
    if (slide.url) URL.revokeObjectURL(slide.url);
  }

  function syncSlides() {
    const first = Math.max(0, index - 1);
    const nearby = photoIds.slice(first, index + 2);
    for (const [id, slide] of slides) {
      if (!nearby.includes(id)) removeSlide(id, slide);
    }
    nearby.forEach((id, slot) => {
      const { node } = slides.get(id) ?? addSlide(id);
      const offset = first + slot - index;
      node.style.transform = `translateX(${offset * 100}%)`;
      node.setAttribute('aria-hidden', String(offset !== 0));
    });
    counter.textContent = `${index + 1} / ${photoIds.length}`;
  }

  function updateZoom() {
    const { image } = slides.get(photoIds[index]) ?? {};
    if (!image) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const fit = image.naturalWidth ? Math.min(w / image.naturalWidth, h / image.naturalHeight) : 0;
    const limitX = Math.max(0, (fit * image.naturalWidth * scale - w) / 2);
    const limitY = Math.max(0, (fit * image.naturalHeight * scale - h) / 2);
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `${translation(x, y)} scale(${scale})`;
    stage.classList.toggle('zoomed', scale > 1);
  }

  function zoom(next, at, before = at) {
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const clamped = clampZoom(next);
    const change = clamped / scale;
    x = at.x - centerX + (x - (before.x - centerX)) * change;
    y = at.y - centerY + (y - (before.y - centerY)) * change;
    scale = clamped;
    updateZoom();
  }

  function settleTrack(x = 0, y = 0, done = () => {}) {
    const from = track.style.transform || translation(0, 0);
    const to = translation(x, y);
    const finish = () => {
      track.style.transform = '';
      done();
    };
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    const animation = track.animate([{ transform: from }, { transform: to }], {
      duration: 200, easing: 'ease-out', fill: 'forwards'
    });
    motion = animation;
    animation.finished.then(() => {
      motion = undefined;
      finish();
      animation.cancel();
    }, () => {});
  }

  function clearTap() {
    clearTimeout(tapTimer);
    pendingTap = undefined;
  }

  function toggleToolbar() {
    pendingTap = undefined;
    toolbar.hidden = !toolbar.hidden;
    if (toolbar.hidden) stage.focus({ preventScroll: true });
  }

  function tap(at) {
    if (pendingTap) {
      const double = at.time - pendingTap.time <= TAP_DELAY && distance(at, pendingTap) <= 32;
      clearTap();
      if (double) {
        zoom(doubleTapZoom(scale), at);
        return;
      }
      toggleToolbar();
    }
    pendingTap = at;
    tapTimer = setTimeout(toggleToolbar, TAP_DELAY);
  }

  function move(direction) {
    clearTap();
    const next = adjacentIndex(index, photoIds.length, direction);
    if (next === null) {
      settleTrack();
      return;
    }
    scale = 1;
    updateZoom();
    index = next;
    settleTrack(-direction * stage.clientWidth, 0, syncSlides);
  }

  function drag(before, after) {
    const dx = after.x - gesture.start.x;
    const dy = after.y - gesture.start.y;
    const { samples } = gesture;
    samples.push(after);
    while (samples.length > 1 && after.time - samples[0].time > FLING_WINDOW) samples.shift();
    if (gesture.mode === 'pending' && Math.hypot(dx, dy) >= TAP_SLOP) {
      clearTap();
      if (scale > 1) gesture.mode = 'pan';
      else if (Math.abs(dx) > Math.abs(dy)) gesture.mode = 'slide';
      else gesture.mode = dy > 0 ? 'pull' : 'ignore';
    }
    if (gesture.mode === 'pan') {
      x += after.x - before.x;
      y += after.y - before.y;
      updateZoom();
    } else if (gesture.mode === 'slide') {
      const width = stage.clientWidth;
      const neighbor = adjacentIndex(index, photoIds.length, -Math.sign(dx));
      const offset = neighbor === null ? dx * 0.24 : dx;
      track.style.transform = translation(Math.max(-width, Math.min(width, offset)), 0);
    } else if (gesture.mode === 'pull') {
      track.style.transform = translation(0, Math.max(0, dy));
    }
  }

  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || motion || pointers.size >= 2) return;
    event.preventDefault();
    const at = point(event);
    pointers.set(event.pointerId, at);
    stage.setPointerCapture(event.pointerId);
    if (pointers.size === 1) gesture = { mode: 'pending', start: at, samples: [at] };
    else {
      clearTap();
      gesture.mode = 'pinch';
      track.style.transform = '';
    }
  });

  stage.addEventListener('pointermove', event => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const after = point(event);
    pointers.set(event.pointerId, after);
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const midpoint = at => ({ x: (at.x + other.x) / 2, y: (at.y + other.y) / 2 });
      zoom(scale * distance(after, other) / Math.max(1, distance(before, other)), midpoint(after), midpoint(before));
    } else drag(before, after);
  });

  function endPointer(event) {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const at = point(event);
    const released = event.type === 'pointerup';
    if (released && pointers.size === 1) drag(before, at);
    pointers.delete(event.pointerId);
    if (pointers.size) {
      gesture.mode = scale > 1 ? 'pan' : 'ignore';
      return;
    }
    const { mode, start, samples } = gesture;
    gesture = undefined;
    if (released) {
      const recent = samples[0];
      const elapsed = Math.max(1, at.time - recent.time);
      if (mode === 'pending' && at.time - start.time <= 350) tap(at);
      if (mode === 'slide') {
        move(swipeDirection(at.x - start.x, stage.clientWidth, (at.x - recent.x) / elapsed));
        return;
      }
      if (mode === 'pull' && swipeDirection(at.y - start.y, stage.clientHeight, (at.y - recent.y) / elapsed) === -1) {
        settleTrack(0, stage.clientHeight, requestClose);
        return;
      }
    }
    settleTrack();
  }

  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, endPointer);
  stage.addEventListener('contextmenu', event => event.preventDefault());
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    if (motion || pointers.size || !event.deltaY) return;
    clearTap();
    zoom(event.deltaY < 0 ? scale * 1.2 : scale / 1.2, point(event));
  }, { passive: false });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (!motion && !pointers.size) move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    requestClose();
  });

  document.body.append(dialog);
  syncSlides();
  dialog.showModal();
  const resize = new ResizeObserver(updateZoom);
  resize.observe(stage);
  if (loadPhotoIds) {
    loadPhotoIds().then(ids => {
      if (!dialog.open) return;
      photoIds = ids;
      index = photoIds.indexOf(photoId);
      counter.hidden = false;
      syncSlides();
    }, () => {});
  }

  return {
    close() {
      clearTap();
      motion?.cancel();
      resize.disconnect();
      dialog.close();
      dialog.remove();
      for (const [id, slide] of slides) removeSlide(id, slide);
      return photoIds[index];
    }
  };
}
