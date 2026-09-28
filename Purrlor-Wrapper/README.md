# Purrlor

A lightweight Windows desktop wrapper for **Purrlor** at https://purr.meowops.net.

## Features
- WebView2 desktop wrapper
- Borderless dark title bar
- Minimize → Maximize/Restore → Close controls
- Windows Snap and edge/corner resizing
- Multi-monitor-aware window state
- Close-to-tray behavior
- Tray icon and tray notifications
- Start with Windows option
- External links open in the default browser
- Downloads go to the Windows Downloads folder
- Self-contained x64 Windows build
- NSIS installer with optional Desktop and Start Menu shortcuts

## Build
Run `Build-Purrlor.bat` on Windows with the .NET 8 SDK and NSIS installed.

Place `MicrosoftEdgeWebview2Setup.exe` in `installer\` if you want the WebView2 bootstrapper bundled into the installer.
