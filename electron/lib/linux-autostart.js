'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getDesktopPath() {
  return path.join(os.homedir(), '.config', 'autostart', '9bizclaw.desktop');
}

function getAppImagePath() {
  return process.env.APPIMAGE || '';
}

function isSupported() {
  return process.platform === 'linux' && !!getAppImagePath();
}

function quoteExec(filePath) {
  return '"' + String(filePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildDesktopEntry() {
  const exe = getAppImagePath();
  if (!exe) return '';
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=9BizClaw',
    `Exec=${quoteExec(exe)}`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=false',
    'Terminal=false',
  ].join('\n') + '\n';
}

function isEnabled() {
  return isSupported() && fs.existsSync(getDesktopPath());
}

function setEnabled(enabled) {
  if (!isSupported()) {
    return { success: false, enabled: false, supported: false, error: 'Linux autostart requires AppImage runtime' };
  }

  const desktopPath = getDesktopPath();
  if (enabled) {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, buildDesktopEntry());
  } else {
    try { fs.unlinkSync(desktopPath); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
  }
  return { success: true, enabled: isEnabled(), supported: true };
}

module.exports = {
  getDesktopPath,
  isEnabled,
  isSupported,
  setEnabled,
};
