const codes = {
  Escape: 0x01, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37,
  AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, NumLock: 0x145, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0x11c,
  ControlRight: 0x11d, NumpadDivide: 0x135, PrintScreen: 0x137, AltRight: 0x138,
  Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d,
  End: 0x14f, ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153,
  MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d
};

for (const [prefix, row, start] of [
  ['Digit', '1234567890', 0x02],
  ['Key', 'QWERTYUIOP', 0x10],
  ['Key', 'ASDFGHJKL', 0x1e],
  ['Key', 'ZXCVBNM', 0x2c]
]) {
  [...row].forEach((key, index) => { codes[prefix + key] = start + index; });
}
for (let i = 1; i <= 10; i++) codes['F' + i] = 0x3a + i;

const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const wheel = value => Number.isInteger(value) && Math.abs(value) <= 1200;

function encodeInput(event, bounds) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'release') return 'R';
  if (event.type === 'key') {
    if (typeof event.code !== 'string' || !Object.hasOwn(codes, event.code) ||
        typeof event.down !== 'boolean') return null;
    return `K ${codes[event.code]} ${Number(event.down)}`;
  }
  if (!unit(event.x) || !unit(event.y)) return null;
  const x = bounds.x + Math.round(event.x * (bounds.width - 1));
  const y = bounds.y + Math.round(event.y * (bounds.height - 1));
  if (event.type === 'move') return `M ${x} ${y}`;
  if (event.type === 'button' && Number.isInteger(event.button) &&
      event.button >= 0 && event.button <= 4 && typeof event.down === 'boolean') {
    return `B ${x} ${y} ${event.button} ${Number(event.down)}`;
  }
  if (event.type === 'wheel' && wheel(event.dx) && wheel(event.dy)) {
    return `W ${x} ${y} ${event.dx} ${event.dy}`;
  }
  return null;
}

module.exports = { encodeInput };
