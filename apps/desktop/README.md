# Purrlor Desktop

A Windows desktop app for **Purrlor**. It hosts a Purrlor web client deployment in Microsoft Edge
WebView2, so it has everything the browser client has (messaging, voice and video, screen share,
encryption, notifications) plus a tray icon and Start with Windows.

## Choosing a server
On first launch the app asks **which Purrlor server** to connect to: the address you'd open
Purrlor at in a browser, e.g. `purr.meowops.net` (the default) or your own deployment's
`app.example.com`. The server name in the title bar (or **Change server…** in the tray menu)
switches it later.

That address is the Purrlor web client, not the Matrix homeserver. The server decides the rest:
a deployment locked to one homeserver (`PURRLOR_HOMESERVER_URL`) signs you in there, and an
unlocked one shows the usual homeserver field on its login screen, so the desktop app works
with any Matrix homeserver that deployment can reach. Voice, invite links, and CORS work the same
as they do in the browser, because the page is loaded from the server itself.

Each server keeps its own sign-in and encryption keys, so switching back picks up where you
left off.

## Features
- WebView2 with the Purrlor server's camera, microphone, notification, clipboard and autoplay
  permissions granted up front (nothing is granted to any other site)
- Borderless dark title bar, Windows Snap and edge/corner resizing, multi-monitor window state
- Close-to-tray, so notifications keep arriving; clicking one opens the room
- Start with Windows (starts in the tray)
- Links to other sites open in the default browser
- Downloads go to the Windows Downloads folder
- Only one copy runs; launching it again brings the window back
- Self-contained x64 build with a per-user NSIS installer (no admin rights). It installs the
  WebView2 Runtime if the machine doesn't have it

Settings and browser data live in `%LOCALAPPDATA%\Purrlor`, and the app itself in
`%LOCALAPPDATA%\Programs\Purrlor`. Uninstalling removes the app but keeps the data.

## Build
Needs the .NET 8 SDK and [NSIS](https://nsis.sourceforge.io). Run `Build-Purrlor.bat` (or
`Build-Purrlor.ps1`); the installer lands at `dist\Purrlor-Setup.exe`.

## Release
Bump `<Version>` in `Purrlor/Purrlor.csproj`, then push a matching tag:

```
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

The `Desktop` workflow builds the installer and publishes it as a GitHub release.
