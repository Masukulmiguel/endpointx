/**
 * EndpointX Dashboard desktop shell.
 *
 * Serves the packaged admin-dashboard build from a loopback origin and opens
 * it in a single window. All API, WebSocket and remote-access traffic leaves
 * the app for https://endpointx.onrender.com because the dashboard only falls
 * back to relative URLs when window.location.hostname is "localhost" - this
 * origin is 127.0.0.1, so it takes the hosted path by design.
 */
const { app, BrowserWindow, dialog, session, shell } = require('electron');
const path = require('node:path');
const { createStaticServer } = require('./server');

const UI_ROOT = path.join(__dirname, 'ui');
const DEFAULT_SIZE = { width: 1440, height: 900 };

// `electron . --smoke` is the packaging gate: it loads the window, checks the
// SPA actually mounted, and exits 0/1 so CI does not need a human.
const SMOKE = process.argv.includes('--smoke');

let mainWindow = null;
let staticServer = null;
let appUrl = null;

// Second launch focuses the existing window instead of stacking another one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.setAppUserModelId('pt.endpointx.dashboard');

  const openExternally = (target) => {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
        return true;
      }
    } catch {
      // not a URL - ignore
    }
    return false;
  };

  const createWindow = () => {
    mainWindow = new BrowserWindow({
      ...DEFAULT_SIZE,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#0f172a',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Links that leave the shell open in the default browser; window.open()
    // from the SPA (reports, help, install snippets) never gets a new window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });

    // Navigating the shell itself to another origin would break the loopback
    // contract, so anything foreign goes to the browser instead.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!appUrl || url.startsWith(appUrl)) return;
      if (openExternally(url)) event.preventDefault();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    if (SMOKE) {
      mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
        console.error(`SMOKE FAIL load ${code}: ${description}`);
        app.exit(1);
      });
      mainWindow.webContents.once('did-finish-load', () => {
        // React mounts during module evaluation; give it a few ticks before
        // deciding the shell is broken rather than merely still loading.
        let attempts = 0;
        const poll = () => {
          void mainWindow.webContents
            .executeJavaScript('Boolean(document.querySelector("#root") && document.querySelector("#root").childElementCount)')
            .then((mounted) => {
              const current = mainWindow.webContents.getURL();
              if (mounted && current.startsWith(appUrl)) {
                console.log(`SMOKE OK url=${current}`);
                app.exit(0);
                return;
              }
              attempts += 1;
              if (attempts >= 10) {
                console.error(`SMOKE FAIL mounted=${mounted} url=${current}`);
                app.exit(1);
                return;
              }
              setTimeout(poll, 300);
            })
            .catch((error) => {
              console.error(`SMOKE FAIL ${error.message}`);
              app.exit(1);
            });
        };
        poll();
      });
    }

    void mainWindow.loadURL(appUrl);
  };

  app.whenReady().then(async () => {
    staticServer = await createStaticServer({ root: UI_ROOT, port: 0 });
    appUrl = `${staticServer.url}/`;

    // CSV/PDF exports and agent install snippets are files the admin asked
    // for, so they get a save dialog instead of landing silently in Downloads.
    session.defaultSession.on('will-download', (_event, item) => {
      item.pause();
      const defaultPath = path.join(app.getPath('downloads'), item.getFilename());
      dialog
        .showSaveDialog(mainWindow, {
          title: 'Guardar ficheiro',
          defaultPath,
          filters: [{ name: item.getFilename(), extensions: [path.extname(item.getFilename()).slice(1) || '*'] }],
        })
        .then(({ canceled, filePath }) => {
          if (canceled || !filePath) {
            item.cancel();
            return;
          }
          item.setSavePath(filePath);
          item.resume();
        })
        .catch(() => item.cancel());
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  const shutdown = () => {
    if (staticServer) {
      staticServer.server.close();
      staticServer = null;
    }
  };

  app.on('window-all-closed', () => {
    shutdown();
    app.quit();
  });

  app.on('before-quit', shutdown);
}
