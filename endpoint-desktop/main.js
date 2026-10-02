const { app, BrowserWindow, Tray, Menu, globalShortcut, shell } = require('electron');
const path = require('path');

const DASHBOARD = (process.env.ENDPOINTX_URL || 'https://endpointx-dashboard.onrender.com').replace(/\/$/, '');
const HERMES_URL = `${DASHBOARD}/hermes`;
const HOTKEY = process.env.ENDPOINTX_HOTKEY || 'CommandOrControl+Alt+H';
const ICON = path.join(__dirname, 'assets', 'hermes.png');

let win = null;
let tray = null;
let quitting = false;
let pendingCall = false;

/** Focus the chat and start the wake-word mic, so saying "HERMES" works straight away. */
function focusHermes() {
  if (!win) return;
  win.webContents
    .executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const text = (b) => (b.textContent || '').trim();
        const alreadyListening = buttons.some((b) => text(b).includes('A ouvir'));
        const input = document.querySelector('input[type="text"], textarea');
        if (input) input.focus();
        if (!alreadyListening) {
          const mic = buttons.find((b) => text(b).includes('Chamar por voz'));
          if (mic) mic.click();
        }
        return true;
      })();
    `)
    .catch(() => {
      // page still loading - retried on did-finish-load
    });
}

function callHermes() {
  if (!win || win.isDestroyed()) {
    pendingCall = true;
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const current = win.webContents.getURL() || '';
  if (!current.includes('/hermes')) {
    pendingCall = true;
    win.loadURL(HERMES_URL);
  } else {
    focusHermes();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    title: 'EndpointX HERMES',
    icon: ICON,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingCall) {
      pendingCall = false;
      setTimeout(focusHermes, 1200);
    }
  });

  win.on('page-title-updated', (event) => event.preventDefault());

  // Closing the window keeps it in the tray, so the hotkey always answers.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.loadURL(HERMES_URL);
}

function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Chamar HERMES', accelerator: HOTKEY, click: callHermes },
    { label: 'Abrir dashboard', click: () => shell.openExternal(DASHBOARD) },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`EndpointX HERMES - ${HOTKEY}`);
  tray.on('click', callHermes);
  tray.on('double-click', callHermes);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => callHermes());

  app.whenReady().then(() => {
    createWindow();
    createTray();
    const ok = globalShortcut.register(HOTKEY, callHermes);
    if (!ok) console.warn(`EndpointX HERMES: shortcut ${HOTKEY} already in use`);
    app.on('activate', () => callHermes());
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Everything that is not our dashboard opens in the normal browser.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(DASHBOARD)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  });
}
