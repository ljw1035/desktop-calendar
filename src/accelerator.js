/**
 * accelerator.js — Electron 全局快捷键（accelerator）工具
 *
 * 纯函数，无 Electron 依赖，便于单元测试。
 * 把浏览器 KeyboardEvent 转成 Electron accelerator 字符串，
 * 并提供给用户看的友好展示格式。
 *
 * Electron accelerator 语法参考：
 *   修饰键：CommandOrControl / Ctrl / Alt / Shift / Super
 *   普通键：字母(A-Z)、数字(0-9)、F1-F24、方向键、Space/Tab/Enter/
 *           Backspace/Delete/Escape 等，以及个别标点(Plus, Comma...)与媒体键
 */

// 默认切换快捷键（Windows / Linux = Ctrl，macOS = Cmd）
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+C';

// e.code 的"主键名" → Electron accelerator 键名
const CODE_TO_KEY = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F',
  KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L',
  KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R',
  KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
  KeyY: 'Y', KeyZ: 'Z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Delete: 'Delete', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', CapsLock: 'Capslock', ContextMenu: 'ContextMenu',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12', F13: 'F13', F14: 'F14',
  F15: 'F15', F16: 'F16', F17: 'F17', F18: 'F18', F19: 'F19', F20: 'F20',
  F21: 'F21', F22: 'F22', F23: 'F23', F24: 'F24',
  // 媒体键（code 与 accelerator 命名一致）
  MediaPlayPause: 'MediaPlayPause', MediaNextTrack: 'MediaNextTrack',
  MediaPreviousTrack: 'MediaPreviousTrack', VolumeUp: 'VolumeUp',
  VolumeDown: 'VolumeDown', VolumeMute: 'VolumeMute',
  // 数字小键盘（保持数字）
  Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3',
  Numpad4: 'num4', Numpad5: 'num5', Numpad6: 'num6', Numpad7: 'num7',
  Numpad8: 'num8', Numpad9: 'num9',
};

// e.code 中表示"纯修饰键"的集合（这些不能单独作为快捷键主键）
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'CapsLock', 'NumLock', 'ScrollLock',
]);

/**
 * 把 KeyboardEvent 转成 Electron accelerator 字符串。
 * 返回 { accelerator: string|null, reason: string|null }
 *  - accelerator 非空即成功（如 "CommandOrControl+Shift+C"）
 *  - 若事件只含修饰键 / 无法识别主键，accelerator=null 并给 reason
 */
function keydownToAccelerator(e) {
  const mods = [];
  if (e.ctrlKey)  mods.push('CommandOrControl');
  if (e.altKey)   mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey)  mods.push('Super');

  const code = e.code;

  // Esc：单独按表示取消，不作为可设快捷键（除非带修饰，但少见）；这里直接拒绝 Esc
  if (code === 'Escape') return { accelerator: null, reason: '已取消（Esc）' };

  // 纯修饰键按下（还没到主键）→ 未完成，不算错误
  if (MODIFIER_CODES.has(code)) return { accelerator: null, reason: null };

  const key = CODE_TO_KEY[code];
  if (!key) {
    return { accelerator: null, reason: `不支持该按键（${e.key || code}）` };
  }

  // 空组合（无任何修饰 + 无主键）不可能发生；但"只有主键无修饰"允许（如 F8、空格）
  const accelerator = mods.length
    ? mods.join('+') + '+' + key
    : key;

  // 安全检查：避免用户误设成"只按一个字母就切换"这种太容易误触的键
  // （单字母/数字/空格无修饰符时几乎必然误触）。这里允许无修饰，但 F 键/媒体键除外？
  // —— 为稳妥：无修饰符的"字母/数字"主键也不建议，但保留 F 键与媒体键这类"平时不会敲"的键。
  const isBareTypeable =
    mods.length === 0 && /^[A-Z0-9]$/.test(key);
  if (isBareTypeable) {
    return { accelerator: null, reason: `请配合 Ctrl/Alt/Shift 使用（单独 ${key} 会与输入冲突）` };
  }

  return { accelerator };
}

/**
 * 把 accelerator 字符串转成适合中文界面展示的友好格式：
 *   CommandOrControl+Shift+C  → Ctrl+Shift+C（Windows/Linux）
 *   也处理 Command / Ctrl / Control 同义词 → Ctrl
 */
function formatAccelerator(acc) {
  if (!acc) return '';
  return String(acc)
    .split('+')
    .map((p) => {
      const t = p.trim();
      const up = t.toUpperCase();
      if (up === 'COMMANDORCONTROL' || up === 'COMMAND' || up === 'CONTROL' || up === 'CTRL') return 'Ctrl';
      if (up === 'SUPER') return 'Win';
      return t; // Shift / Alt / 键名保持不变
    })
    .join('+');
}

// UMD 风格导出：Node（单元测试）用 module.exports，浏览器（settings.js）挂到 window 全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_SHORTCUT, keydownToAccelerator, formatAccelerator };
}
if (typeof window !== 'undefined') {
  window.accelerator = { DEFAULT_SHORTCUT, keydownToAccelerator, formatAccelerator };
}
