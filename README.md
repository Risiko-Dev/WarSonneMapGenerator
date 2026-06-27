# Maze Recon v2 — WZ2100 Map Generator

Ein zellbasierter **Labyrinth-Generator** für [Warzone 2100](https://wz2100.net/).
Erzeugt rotationssymmetrische Karten mit scharfen Wänden, Räumen, Hauptrouten,
Wasser, Scavenger-Camps und Ressourcen — direkt im Browser, exportierbar als `.wz`.

🔗 **Live:** https://risiko-dev.github.io/WarSonneMapGenerator/

![Status: Grid-First · Block-Maze v2](https://img.shields.io/badge/engine-Block--Maze%20v2-e0a34e)

## Features

- **Grid-First-Labyrinth** — rotationssymmetrisch, scharfe Wände, faire Aufstellung für 2–9 Spieler.
- **Seed-basiert** — reproduzierbare Karten über einen Zahlen-Seed.
- **Voll parametrisierbar:**
  - Zellen pro Achse (21–51) und Gang-Breite (WZ-Kacheln)
  - *Verschlungenheit* (perfektes Labyrinth ↔ Schleifen) und Ring-Verbindungen
  - Zentrum- und Basis-Größe, hervorgehobene Hauptroute
  - Geflutete Korridore mit Brücken-Chokes (Wasser-Dichte)
  - Optionale Scavenger-Außenposten in Sackgassen
- **Live-Vorschau** auf Canvas inklusive Validierung (PASS/FAIL).
- **`.wz`-Export** mit einstellbarer Wand- und Boden-Höhe (max. 256×256 Kacheln).

## Nutzung

Reine statische Web-App — kein Build, keine Abhängigkeiten.

1. `index.html` im Browser öffnen (oder die Live-Seite besuchen).
2. Spieleranzahl, Seed und Labyrinth-Parameter einstellen.
3. **⚡ Karte generieren** klicken — die Vorschau erscheint sofort.
4. **📥 Karte herunterladen (.wz)** und in Warzone 2100 importieren.

### Lokal starten

```bash
git clone https://github.com/Risiko-Dev/WarSonneMapGenerator.git
cd WarSonneMapGenerator
# index.html direkt öffnen — oder ein kleiner lokaler Server:
python -m http.server 8000
# → http://localhost:8000
```

## Projektstruktur

| Datei        | Inhalt                                                            |
| ------------ | ---------------------------------------------------------------- |
| `index.html` | UI, Steuerelemente und Canvas                                    |
| `style.css`  | Design / Layout                                                  |
| `app.js`     | `MazeRecon`-Namespace: RNG → Builder → Post → Validate → Render → Export → UI |

## Lizenz

Privates Projekt. Alle Rechte vorbehalten, sofern nicht anders angegeben.
