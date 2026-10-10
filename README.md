# Zentro Download Manager

A fast, secure download manager for Windows 10 and 11. Electron + HTML/CSS/JavaScript, no runtime dependencies.

- Streaming downloads straight to disk (never loaded into memory)
- Live progress, speed and time remaining
- Pause, resume, cancel (pause/resume needs a server that supports HTTP Range requests)
- Automatic retry and resume after dropped connections
- Download history that survives restarts
- Windows notifications, taskbar progress, native minimize/maximize/close buttons

## Get Zentro-Setup.exe (no developer tools needed)

The installer is built for you by GitHub on a Windows machine.

1. Create a free account at https://github.com and make a **new repository** (private is fine).
2. Upload this project to it. Easiest with Git (https://git-scm.com), in this folder:
   ```
   git init
   git add .
   git commit -m "Zentro"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
   git push -u origin main
   ```
   (The hidden `.github` folder must be included - the commands above do that.)
3. Open the repository's **Actions** tab. The build **Build Zentro (Windows)** starts by itself
   (or press **Run workflow**). It takes about 3 to 5 minutes.
4. Open the finished run, scroll to **Artifacts** and download **Zentro-Setup**.
   Unzip it - inside is `Zentro-Setup.exe`.
5. Double-click `Zentro-Setup.exe`, pick a folder (or keep the default), and press Install.
   Zentro is added to the Start Menu and the desktop.

Tip: push a tag such as `git tag v1.0.0 && git push origin v1.0.0` and the exe is also attached
to a **Release**, which gives you a direct download link without the zip.

### Windows SmartScreen warning
The installer isn't code-signed (that needs a paid certificate), so Windows may say
"Windows protected your PC". Press **More info**, then **Run anyway**. You built it yourself from this source.

## Build on your own Windows PC

Requires Node.js 20 or newer (https://nodejs.org).

```
npm install
npm start            # run the app
npm run dev          # run with developer tools
npm test             # run the download engine tests
npm run build:win    # creates dist\Zentro-Setup.exe
```
If the build stops with a "symbolic link" error, turn on **Developer Mode** in Windows
(Settings > System > For developers) or run the terminal as Administrator, then build again.

## How it is put together

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: window, IPC, notifications, dialogs |
| `preload.js` | The only bridge the page gets (`window.zentro`) |
| `src/downloader.js` | Streaming engine: redirects, Range resume, retry, queue, history |
| `src/security.js` | URL validation, safe file names, path checks, dangerous-file list |
| `src/store.js` | Atomic JSON storage for settings and history |
| `renderer/` | The interface (no inline scripts, strict CSP) |
| `test/` | Node tests that run the engine against a local test server |

## Security notes

- Only `http:` and `https:` links; redirects are re-checked and https to http downgrades are refused.
- Renderer: `nodeIntegration` off, `contextIsolation` on, `sandbox` on, strict Content-Security-Policy,
  navigation and new windows blocked, permission requests denied, all network requests from the page blocked.
- IPC: only known channels, sender checked, ids and settings validated. The page sends download ids, never file paths.
- File names are sanitised (folders, reserved names such as `CON`, trailing dots, hidden-character tricks) and
  every path is checked to stay inside the download folder.
- Zentro never runs a download by itself. Opening `.exe`, `.msi`, `.bat`, `.ps1` and similar files asks first.
- Downloads left running when you quit come back as **Paused** and wait for you to press Resume.

## Known limits

- Links with a login inside them (`https://user:pass@...`) and sites that need you to be signed in are not supported.
- Servers that don't support Range requests can't be paused, and a dropped connection restarts that download.
- The installer creates the desktop shortcut by default (uninstall removes it). Making it a tick box needs a custom NSIS page.
