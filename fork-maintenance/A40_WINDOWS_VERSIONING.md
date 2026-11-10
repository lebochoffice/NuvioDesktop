# A40-Fork Windows versions

After integrating a published upstream release, set the desktop version to
`0.1.35-A40-Fork` (next example: `0.1.36-A40-Fork`). The window renders
`Nuvio 0.1.35 A40-Fork`. The launcher and desktop shortcut stay `Nuvio`.

Build with `-Pnuvio.windows.a40Fork=true` and explicitly choose a numeric
`-Pnuvio.windows.a40MsiVersion=1.2.35`. Increase that numeric version and the
desktop version code monotonically. Keep the A40 UpgradeCode and profile
directories stable. Check that each new MSI has a new ProductCode and can
upgrade the previous A40 MSI without touching its profiles.
