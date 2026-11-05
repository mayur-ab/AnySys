const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function bindViewerInput(viewport, video, leaveButton, canControl, send) {
  let pointer;
  let pendingMove;
  let frame;
  const buttons = new Set();

  function position(event, allowOutside = false) {
    if (!video.videoWidth) return null;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    if (!allowOutside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = undefined;
    pendingMove = undefined;
    const captured = pointer;
    pointer = undefined;
    if (captured !== undefined && viewport.hasPointerCapture(captured)) viewport.releasePointerCapture(captured);
    buttons.clear();
    if (canControl()) send({ type: 'release' });
  }

  viewport.addEventListener('pointermove', event => {
    if (!canControl() || event.pointerType !== 'mouse') return;
    const point = position(event, pointer !== undefined);
    if (!point) return;
    pendingMove = { type: 'move', ...point };
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      if (pendingMove && canControl()) send(pendingMove);
      frame = undefined;
      pendingMove = undefined;
    });
  });

  // Mouse events report additional buttons pressed during a chord.
  for (const [name, down] of [['mousedown', true], ['mouseup', false]]) {
    viewport.addEventListener(name, event => {
      if (!canControl() || event.button < 0 || event.button > 4) return;
      const point = position(event, pointer !== undefined);
      if (!point || (!down && !buttons.has(event.button))) return;
      event.preventDefault();
      pendingMove = undefined;
      if (down) {
        viewport.focus({ preventScroll: true });
        buttons.add(event.button);
      } else {
        buttons.delete(event.button);
      }
      send({ type: 'button', ...point, button: event.button, down });
    });
  }
  viewport.addEventListener('pointerdown', event => {
    if (!canControl() || event.pointerType !== 'mouse' || !position(event)) return;
    pointer = event.pointerId;
    viewport.setPointerCapture(pointer);
  });
  viewport.addEventListener('lostpointercapture', event => {
    setTimeout(() => {
      if (pointer !== event.pointerId || viewport.hasPointerCapture(pointer)) return;
      pointer = undefined;
      if (buttons.size) reset();
    }, 0);
  });
  viewport.addEventListener('pointercancel', reset);
  viewport.addEventListener('contextmenu', event => {
    if (canControl()) event.preventDefault();
  });
  viewport.addEventListener('wheel', event => {
    if (!canControl()) return;
    const point = position(event);
    if (!point) return;
    event.preventDefault();
    pendingMove = undefined;
    const factor = [1.2, 40, 120][event.deltaMode] ?? 1.2;
    const dx = clamp(Math.round(event.deltaX * factor), -1200, 1200);
    const dy = clamp(Math.round(-event.deltaY * factor), -1200, 1200);
    if (dx || dy) send({ type: 'wheel', ...point, dx, dy });
  }, { passive: false });

  for (const [name, down] of [['keydown', true], ['keyup', false]]) {
    viewport.addEventListener(name, event => {
      if (!canControl()) return;
      if (down && event.ctrlKey && event.shiftKey && event.code === 'F8') {
        event.preventDefault();
        leaveButton.focus();
        return;
      }
      if (!event.code) return;
      event.preventDefault();
      send({ type: 'key', code: event.code, down });
    });
  }
  viewport.addEventListener('blur', reset);
  window.addEventListener('blur', reset);
  return reset;
}
