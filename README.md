# CPN IDE für macOS (Apple Silicon)

Eigenständige Mac-App mit der offiziellen **CPN IDE 1.24** (Editor, Deklarationen, Typprüfung,
Simulation, Monitore, Replikationen) – derselbe Funktionsumfang wie CPN IDE bzw. die VS-Code-Extension.

## Aufbau

| Teil | Woher | Läuft |
|---|---|---|
| Oberfläche (Angular) | offizieller CPN-IDE-Installer, `ui/` | nativ in Electron (arm64) |
| Backend + CPN-Simulator | Image `ghcr.io/alefire99/cpn-ide-backend` | Docker (amd64, emuliert) |

Der CPN-Simulator ist ein 32-Bit-Linux-Programm und läuft auf dem Mac nur in Docker. Die App startet
den Container beim Öffnen automatisch (`cpn-ide-mac-backend`, nur auf 127.0.0.1) und entfernt ihn beim Beenden.
Er läuft mit tmpfs für `/data` und `/tmp`: Der emulierte 32-Bit-Simulator kann auf ext4 keine
Verzeichnisse lesen und meldet sonst „Exception raised while setting paths: SysErr“.

## Mehrere Fenster

Jedes Fenster ist eine eigene CPN-IDE-Instanz mit eigenem Backend-Container (`cpn-ide-mac-backend`,
`cpn-ide-mac-backend-2`, …) und eigenem Speicherbereich. Neues Fenster: Ablage → Neues Fenster (⇧⌘N),
Datei in neuem Fenster: ⇧⌘O, oder Rechtsklick aufs Dock-Symbol. Doppelklick auf eine `.cpn`-Datei öffnet sie
in einem neuen Fenster, außer es gibt ein Fenster, in dem noch kein Modell geladen ist.
Jeder Container braucht etwa 0,5–1 GB RAM.

## Voraussetzungen

- Docker Desktop (wird bei Bedarf automatisch gestartet)
- Beim ersten Start wird das Backend-Image geladen (einmalig, ca. 400 MB)

## Bauen

```bash
npm install
npm run fetch-ui   # nur nötig, wenn ui/ fehlt (braucht: brew install innoextract)
npm run package    # -> dist/CPN IDE-darwin-arm64/CPN IDE.app
```

Zum Entwickeln: `npm start` (optional mit Pfad zu einer `.cpn`-Datei).

## Dateien

- `src/main.js`: Fenster, Menü, Docker-Backend, Öffnen/Speichern (Kodierung laut XML-Kopf, meist ISO-8859-1)
- `src/preload.js`: bildet das alte Electron-API nach, das die Oberfläche erwartet (`remote.dialog`, `fs`, IPC-Menübefehle)
- `src/splash.html`: Startbildschirm, solange das Backend hochfährt
- `scripts/patch-ui.js`: Änderungen an der offiziellen UI (läuft nach `fetch-ui` automatisch). Die roten Token
  laufen flüssig entlang der Pfeile statt per SMIL-Animation, im Einzelschritt 450 ms pro Phase.
  Seitenwechsel über den Projektbaum ohne die eingebaute Wartezeit von 1 s.

Testinstanz neben der installierten App (eigene Container, eigene Daten): `CPN_IDE_DEV_TAG=test npm start`.

Lizenz: CPN IDE und das Backend stehen unter AGPL-3.0.
