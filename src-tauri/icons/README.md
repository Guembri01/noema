# Icons

Tauri needs a real icon set to build an installer. They are **generated**, never
hand-edited, so the source of truth is one 1024x1024 PNG:

    npx.cmd tauri icon assets/icon.png

That writes every size this directory needs:

    icons/32x32.png  128x128.png  128x128@2x.png  icon.icns  icon.ico
    icons/StoreLogo.png  Square*Logo.png  icons/tray.png

`tray.png` (16x16, monochrome) is what the tray uses; `iconAsTemplate: true`
makes macOS tint it correctly in light/dark menu bars.

Until `tauri icon` has been run this directory is intentionally empty apart from
this file, and `npm run desktop:icons` will stop with a clear message.
