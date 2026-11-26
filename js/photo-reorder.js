const HOLD_MS = 500;
const MOVE_TOLERANCE = 8;
const SCROLL_EDGE = 90;

export function moveItem(items, from, to) {
  const order = items.slice();
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  return order;
}

function measureRows(tiles, grid) {
  const rows = [];
  Array.from(tiles.children).forEach((item, index) => {
    const rect = item.getBoundingClientRect();
    const top = rect.top - grid.top;
    let row = rows.at(-1);
    if (row?.top !== top) {
      row = { top, center: top + rect.height / 2, slots: [] };
      rows.push(row);
    }
    row.slots.push({ center: rect.left - grid.left + rect.width / 2, index });
  });
  return rows;
}

function nearest(items, point) {
  let best = items[0];
  for (const item of items) {
    if (Math.abs(item.center - point) < Math.abs(best.center - point)) best = item;
  }
  return best;
}

export function enablePhotoReorder(tiles, { ready, filtered, onBlocked, onDrop }, scope) {
  let gesture;
  let suppressClick = false;

  function place(active, index) {
    if (index === active.index) return;
    const reference = index > active.index ? index + 1 : index;
    tiles.insertBefore(active.item, tiles.children[reference] ?? null);
    active.index = index;
  }

  function followPointer(active) {
    active.preview.style.translate = `${active.x - active.offsetX}px ${active.y - active.offsetY}px`;
  }

  function previewPosition(active) {
    followPointer(active);
    const grid = tiles.getBoundingClientRect();
    if (grid.width !== active.gridWidth) {
      active.rows = measureRows(tiles, grid);
      active.gridWidth = grid.width;
    }
    const row = nearest(active.rows, active.y - grid.top);
    place(active, nearest(row.slots, active.x - grid.left).index);
  }

  function finish(save = false) {
    if (!gesture) return;
    const active = gesture;
    gesture = undefined;
    clearTimeout(active.timer);
    if (active.frame !== undefined) cancelAnimationFrame(active.frame);
    if (tiles.hasPointerCapture(active.pointerId)) tiles.releasePointerCapture(active.pointerId);
    if (!active.overlay) return;
    active.overlay.remove();
    active.item.classList.remove('photo-drop-slot');
    tiles.classList.remove('reordering-photos');
    if (save && active.index !== active.from) onDrop(moveItem(active.ids, active.from, active.index));
    else place(active, active.from);
  }

  function cancel() { finish(); }

  function lift(active) {
    if (!scope.current() || !tiles.isConnected) return cancel();
    suppressClick = true;
    if (filtered()) return onBlocked();
    try {
      tiles.setPointerCapture(active.pointerId);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      return cancel();
    }

    const children = Array.from(tiles.children);
    active.ids = children.map(item => item.dataset.photoId);
    active.from = active.index = children.indexOf(active.item);
    const rect = active.tile.getBoundingClientRect();
    active.offsetX = active.x - rect.left;
    active.offsetY = active.y - rect.top;
    active.preview = active.tile.cloneNode(true);
    active.preview.removeAttribute('href');
    active.preview.classList.add('tile-in-hand');
    active.preview.style.width = `${rect.width}px`;
    active.overlay = document.createElement('div');
    active.overlay.className = 'photo-drag-overlay';
    active.overlay.setAttribute('aria-hidden', 'true');
    active.overlay.append(active.preview);
    followPointer(active);
    tiles.after(active.overlay);
    active.item.classList.add('photo-drop-slot');
    tiles.classList.add('reordering-photos');
    navigator.vibrate?.(15);
  }

  function schedulePreview() {
    const active = gesture;
    if (!active?.moved || active.frame !== undefined) return;
    active.frame = requestAnimationFrame(time => {
      active.frame = undefined;
      if (!scope.current() || !tiles.isConnected) return cancel();
      const edge = Math.min(SCROLL_EDGE, window.innerHeight / 4);
      const upward = Math.max(0, edge - active.y);
      const downward = Math.max(0, edge - (window.innerHeight - active.y));
      const strength = (downward - upward) / edge;
      const elapsed = Math.min(32, time - (active.frameTime ?? time - 16));
      active.frameTime = time;
      const before = window.scrollY;
      if (strength) {
        const top = Math.sign(strength) * Math.max(1, Math.min(1, Math.abs(strength)) * elapsed);
        window.scrollBy({ top, behavior: 'instant' });
      }
      previewPosition(active);
      if (window.scrollY !== before) schedulePreview();
    });
  }

  scope.listen(tiles, 'pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    suppressClick = false;
    const tile = event.target.closest('.tile');
    if (!tile || !ready()) return;
    const { pointerId, clientX: x, clientY: y } = event;
    const active = { pointerId, tile, item: tile.parentElement, x, y, startX: x, startY: y };
    active.timer = setTimeout(() => lift(active), HOLD_MS);
    gesture = active;
  });
  scope.listen(window, 'pointermove', event => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.overlay) {
      gesture.moved = true;
      schedulePreview();
    } else if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > MOVE_TOLERANCE) {
      cancel();
    }
  });
  scope.listen(window, 'pointerup', event => {
    if (gesture?.pointerId !== event.pointerId) return;
    if (!scope.current()) return cancel();
    if (gesture.overlay && (gesture.moved || gesture.x !== event.clientX || gesture.y !== event.clientY)) {
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      previewPosition(gesture);
    }
    finish(true);
  });
  scope.listen(window, 'pointercancel', event => {
    if (gesture?.pointerId === event.pointerId) cancel();
  });
  scope.listen(tiles, 'lostpointercapture', event => {
    if (event.target === tiles && gesture?.pointerId === event.pointerId) cancel();
  });
  scope.listen(tiles, 'click', event => {
    if (suppressClick && event.detail > 0) event.preventDefault();
  });
  scope.listen(tiles, 'contextmenu', event => {
    if (event.target.closest('.tile') || gesture) event.preventDefault();
  });

  // Keep native scrolling available during the hold. Once lifted, cancel touch scrolling
  // before Chrome commits to it and sends pointercancel.
  function preventDragScroll(event) {
    if (gesture?.overlay && event.cancelable) event.preventDefault();
  }
  tiles.addEventListener('touchmove', preventDragScroll, { passive: false });
  scope.onLeave(() => tiles.removeEventListener('touchmove', preventDragScroll));
  scope.listen(window, 'scroll', schedulePreview);
  scope.listen(window, 'resize', schedulePreview);
  scope.listen(window, 'blur', cancel);
  scope.listen(document, 'visibilitychange', () => {
    if (document.hidden) cancel();
  });
  scope.listen(window, 'keydown', event => {
    if (event.key === 'Escape') cancel();
  });
  scope.onLeave(cancel);
  return cancel;
}
