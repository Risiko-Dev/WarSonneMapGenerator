/* =========================================================================
 *  MAZE RECON v2 — Labyrinth-Kartengenerator für Warzone 2100 (.wz)
 * =========================================================================
 *  Alles hängt unter dem globalen Objekt `MazeRecon`. Die Pipeline läuft
 *  in klar getrennten Schritten, jeder in seinem eigenen Modul:
 *
 *    Builder   – baut das rohe Labyrinth-Gitter (Räume, Gänge)
 *    Post      – Nachbearbeitung (Routen, Wasser, Reparatur, Ressourcen)
 *    Validate  – prüft Erreichbarkeit, Fairness usw.
 *    Render    – zeichnet die Vorschau auf das Canvas
 *    Export    – packt alles in eine .wz-Datei (ZIP)
 *    UI        – verbindet die Bedienelemente mit der Pipeline
 *
 *  Zwei Koordinatensysteme tauchen überall auf:
 *    • Zell-Koordinaten (i, j)  – das logische Labyrinth, M×M Zellen.
 *    • Gitter-Koordinaten (x, y) – das gezeichnete Raster, W×W Felder,
 *      wobei W = 2*M + 1. Zellen liegen auf ungeraden Indizes
 *      (Gitter = 2*Zelle + 1); die geraden Indizes dazwischen sind die
 *      Wände bzw. Durchgänge.
 * ========================================================================= */

"use strict";

const MazeRecon = {};

/* =========================================================================
 *  1. KACHEL-TYPEN & FARBEN
 *     Jede Gitter-Zelle hält einen dieser Zahlenwerte.
 * ========================================================================= */

MazeRecon.Tile = {
  WALL:      0,
  FLOOR:     1,
  MAIN:      2,   // hervorgehobene Hauptroute Basis → Zentrum
  BASE:      3,
  HUB:       5,   // Zentrum
  WATER:     7,
  BRIDGE:    8,   // begehbarer Übergang über Wasser
  RESOURCE: 10,
  SCAVENGER: 11
};

// Farbe [r, g, b] je Kacheltyp für die Canvas-Vorschau.
MazeRecon.Colors = {
  0:  [23, 29, 36],     // WALL      – dunkles Schiefergrau
  1:  [156, 138, 99],   // FLOOR     – Sand
  2:  [224, 163, 78],   // MAIN      – Gold (Hauptroute)
  3:  [203, 182, 138],  // BASE      – warmes Beige
  5:  [181, 137, 106],  // HUB       – Terrakotta
  7:  [44, 86, 111],    // WATER     – Tiefblau
  8:  [154, 122, 82],   // BRIDGE    – Holzbraun
  10: [86, 158, 110],   // RESOURCE  – Grün
  11: [148, 140, 132]   // SCAVENGER – Steingrau
};

// Ringfarben der Spielerbasen (rotieren bei mehr als 8 Spielern durch).
MazeRecon.PlayerColors = [
  '#7FB069', '#E0A34E', '#5BA3C7', '#D9583B',
  '#B57FD9', '#D9C04E', '#6BC2A6', '#E07FA8'
];

MazeRecon.ScavColor = '#9e9a95';

/* =========================================================================
 *  2. ZUFALLSZAHLEN
 *     Deterministisch: gleicher Seed → gleiche Karte. Jede Phase der
 *     Generierung zieht ihren eigenen Strom, damit das Ändern eines
 *     Parameters nicht die ganze Karte umwürfelt.
 * ========================================================================= */

MazeRecon.RNG = {

  /** Wandelt einen Seed-String in einen 32-Bit-Generator (liefert ganze Zahlen). */
  hash(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  },

  /** Mulberry32 – liefert Gleitkommazahlen in [0, 1). */
  float(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /** Eigener Zufallsstrom für eine benannte Phase ("maze", "water", …). */
  forPhase(seed, phase) {
    const seedNumber = this.hash(seed + '·' + phase)();
    return this.float(seedNumber);
  }
};

/* =========================================================================
 *  3. ROTATIONS-SYMMETRIE
 *     Karten werden rotationssymmetrisch aufgebaut, damit alle Spieler
 *     fair starten. `fold` ist die Anzahl der Drehbilder:
 *       fold = 4 → 90°-Schritte | fold = 2 → 180° | fold = 1 → nur das Original.
 * ========================================================================= */

MazeRecon.Symmetry = {

  /** Liefert alle Drehbilder der Zelle (i, j) in einem `size`×`size`-Feld. */
  images(i, j, size, fold) {
    const list = [[i, j]];
    let ci = i, cj = j;
    for (let k = 1; k < fold; k++) {
      if (fold === 4) {
        // 90°-Drehung
        const ni = size - 1 - cj, nj = ci;
        ci = ni;
        cj = nj;
      } else {
        // 180°-Drehung
        ci = size - 1 - ci;
        cj = size - 1 - cj;
      }
      list.push([ci, cj]);
    }
    return list;
  }
};

/* =========================================================================
 *  4. LABYRINTH-BUILDER
 *     Baut das rohe Gitter in klaren Teilschritten auf:
 *       init → Zentrum → Basen → (Scavenger-Zonen) → Gänge graben
 *       → Verschlingen → Ringe → Basis-Ausgänge → rastern → packen
 * ========================================================================= */

MazeRecon.Builder = {

  // ── Einstiegspunkt ────────────────────────────────────────────────
  build(cfg) {
    const state = this._init(cfg);
    this._placeHub(state);
    this._placeBases(state);
    if (state.scavMode) this._reserveScavZones(state);
    this._carveMaze(state);
    this._addBraiding(state);
    this._addRings(state);
    this._addBaseGates(state);
    this._rasterize(state);
    return this._pack(state);
  },

  // ── Arbeitszustand anlegen ────────────────────────────────────────
  _init(cfg) {
    const M = cfg.cells;                                  // Zellen pro Achse
    const R = cfg.R;                                      // gewünschte Symmetrie
    const bpd = cfg.bpd;                                  // Basen pro Sektor
    const sym = (cfg.placement === 'random') ? 1 : R;     // tatsächliche Faltung
    const W = 2 * M + 1;                                  // Gitterbreite

    return {
      M, R, bpd, sym, W,
      seed:      cfg.seed,
      hubR:      cfg.hubR,
      baseR:     cfg.baseR,
      braid:     cfg.braid,
      rings:     cfg.rings,
      scavMode:  cfg.scavMode,
      placement: cfg.placement,

      // Koordinaten-Helfer
      idx:    (x, y) => y * W + x,      // Gitter (x, y) → flacher Index
      cell:   (i)    => 2 * i + 1,      // Zellindex → Gitterindex
      flat:   (i, j) => i * M + j,      // Zelle (i, j) → flacher Index
      inGrid: (i, j) => i >= 0 && j >= 0 && i < M && j < M,
      hc:     (M - 1) >> 1,             // Mittelzelle (Zentrum)

      // Datenfelder
      grid:    new Uint8Array(W * W),
      visited: new Uint8Array(M * M),
      room:    new Int16Array(M * M).fill(-1),  // -1 = Gang, 0 = Hub, ≥1 = Basis-Spieler+1
      hubCells: [],
      bases:    [],
      edges:    new Set(),    // offene Verbindungen zwischen Zellen
      playerId: 0,
      scavZones: []
    };
  },

  // Eindeutiger, richtungsunabhängiger Schlüssel für die Kante (a,b)–(c,d).
  _key(M, a, b, c, d) {
    const p = a * M + b, q = c * M + d;
    return p < q ? p + '|' + q : q + '|' + p;
  },

  // Öffnet die Kante (i1,j1)–(i2,j2) und alle ihre symmetrischen Drehbilder.
  _edgeSym(state, i1, j1, i2, j2) {
    const { M, sym, edges } = state;
    let a = [i1, j1], b = [i2, j2];
    for (let k = 0; k < sym; k++) {
      edges.add(this._key(M, a[0], a[1], b[0], b[1]));
      if (sym === 4) {
        a = [M - 1 - a[1], a[0]];
        b = [M - 1 - b[1], b[0]];
      } else {
        a = [M - 1 - a[0], M - 1 - a[1]];
        b = [M - 1 - b[0], M - 1 - b[1]];
      }
    }
  },

  // Markiert die Zelle (i, j) und ihre Drehbilder als besucht.
  _markSym(state, i, j) {
    for (const [ci, cj] of MazeRecon.Symmetry.images(i, j, state.M, state.sym)) {
      state.visited[state.flat(ci, cj)] = 1;
    }
  },

  // Dreht eine Zelle um einen Symmetrieschritt weiter.
  _rotCell(state, i, j) {
    return state.sym === 4
      ? [state.M - 1 - j, i]
      : [state.M - 1 - i, state.M - 1 - j];
  },

  // ── Zentrum (Hub) platzieren ──────────────────────────────────────
  _placeHub(state) {
    const { hc, hubR, room, flat, inGrid } = state;
    for (let i = hc - hubR; i <= hc + hubR; i++) {
      for (let j = hc - hubR; j <= hc + hubR; j++) {
        if (inGrid(i, j)) {
          room[flat(i, j)] = 0;
          state.hubCells.push([i, j]);
        }
      }
    }
  },

  // Beansprucht einen baseR×baseR-Block ab (ai, aj) für den nächsten Spieler.
  // Der Block wächst Richtung Zentrum; mit useSym auch für alle Drehbilder.
  _claimBlock(state, ai, aj, useSym) {
    const { hc, baseR, room, flat, inGrid, sym, bases } = state;
    const di = Math.sign(hc - ai) || 1;
    const dj = Math.sign(hc - aj) || 1;

    let block = [];
    for (let a = 0; a < baseR; a++) {
      for (let b = 0; b < baseR; b++) {
        block.push([ai + a * di, aj + b * dj]);
      }
    }

    const reps = useSym ? sym : 1;
    for (let k = 0; k < reps; k++) {
      const cells = [];
      for (const [x, y] of block) {
        if (inGrid(x, y) && room[flat(x, y)] < 0) {
          room[flat(x, y)] = state.playerId + 1;
          cells.push([x, y]);
        }
      }
      if (cells.length) {
        let cx = 0, cy = 0;
        for (const c of cells) { cx += c[0]; cy += c[1]; }
        bases.push({
          player: state.playerId,
          cells,
          ci: Math.round(cx / cells.length),
          cj: Math.round(cy / cells.length)
        });
        state.playerId++;
      }
      block = block.map(([x, y]) => this._rotCell(state, x, y));
    }
  },

  // ── Basen platzieren ──────────────────────────────────────────────
  _placeBases(state) {
    const { M, hc, hubR, R, bpd, bases, seed, placement } = state;

    if (placement === 'random') {
      // Zufällige, aber faire Aufstellung: Abstand zueinander, weg vom
      // Zentrum und nicht in den Ecken.
      const rng = MazeRecon.RNG.forPhase(seed, 'place');
      const minDist = Math.max(5, (M * 0.18) | 0);
      const minHub  = Math.max(hubR + 5, (M * 0.40) | 0);
      const cornerRadius = 4, lo = 4, hi = M - 5;
      const corners = [[lo, lo], [lo, hi], [hi, lo], [hi, hi]];
      let tries = 0;

      while (bases.length < R * bpd && tries < 6000) {
        tries++;
        const i = 2 + ((rng() * (M - 4)) | 0);
        const j = 2 + ((rng() * (M - 4)) | 0);
        if (state.room[state.flat(i, j)] >= 0) continue;
        if (Math.hypot(i - hc, j - hc) < minHub) continue;
        if (corners.some(([cx, cy]) => Math.max(Math.abs(i - cx), Math.abs(j - cy)) <= cornerRadius)) continue;
        if (bases.some(b => Math.hypot(b.ci - i, b.cj - j) < minDist)) continue;
        this._claimBlock(state, i, j, false);
      }
    } else {
      // Symmetrische Aufstellung: Anker auf einem Kreis um das Zentrum.
      const jit = MazeRecon.RNG.forPhase(seed, 'anchor');
      const rad = (hc - 3) - ((jit() * 3) | 0);
      const polar = deg => {
        const a = deg * Math.PI / 180;
        return [Math.round(hc + rad * Math.cos(a)), Math.round(hc - rad * Math.sin(a))];
      };
      let anchors;
      if (R === 4) {
        const d = (jit() - 0.5) * 40;
        anchors = bpd === 2 ? [polar(22 + d * 0.4), polar(68 + d * 0.4)] : [polar(45 + d)];
      } else {
        const d = (jit() - 0.5) * 30;
        anchors = bpd === 3 ? [polar(150 + d), polar(90 + d), polar(30 + d)] : [polar(45 + d)];
      }
      for (const [ai, aj] of anchors) this._claimBlock(state, ai, aj, true);
    }
  },

  // ── Scavenger-Zonen reservieren ───────────────────────────────────
  _reserveScavZones(state) {
    const { M, hc, hubR, room, flat, scavZones } = state;
    const rng = MazeRecon.RNG.forPhase(state.seed, 'scav');
    const count = Math.max(1, Math.round(M * 0.08));

    for (let attempt = 0; attempt < count * 30; attempt++) {
      const i = 3 + ((rng() * (M - 6)) | 0);
      const j = 3 + ((rng() * (M - 6)) | 0);
      if (room[flat(i, j)] >= 0) continue;
      if (Math.hypot(i - hc, j - hc) < hubR + 4) continue;
      if (scavZones.some(z => Math.hypot(z[0] - i, z[1] - j) < 4)) continue;
      scavZones.push([i, j]);
      if (scavZones.length >= count) break;
    }
  },

  // ── Gänge graben (symmetrischer Tiefensuche-Backtracker) ──────────
  _carveMaze(state) {
    const { M, room, visited, flat, inGrid, hc, hubR, hubCells, bases, seed } = state;

    // Räume (Hub & Basen) gelten als besucht – durch sie wird nicht gegraben.
    for (let k = 0; k < M * M; k++) {
      if (room[k] >= 0) visited[k] = 1;
    }

    // Innenkanten von Hub und Basen offen halten, damit Räume verbunden sind.
    for (const [i, j] of hubCells) {
      if (inGrid(i + 1, j) && room[flat(i + 1, j)] === 0) state.edges.add(this._key(M, i, j, i + 1, j));
      if (inGrid(i, j + 1) && room[flat(i, j + 1)] === 0) state.edges.add(this._key(M, i, j, i, j + 1));
    }
    for (const b of bases) {
      for (const [i, j] of b.cells) {
        if (b.cells.some(c => c[0] === i + 1 && c[1] === j)) state.edges.add(this._key(M, i, j, i + 1, j));
        if (b.cells.some(c => c[0] === i && c[1] === j + 1)) state.edges.add(this._key(M, i, j, i, j + 1));
      }
    }

    // Startzelle direkt neben dem Zentrum wählen.
    const rng = MazeRecon.RNG.forPhase(seed, 'maze');
    let si = hc + hubR + 1, sj = hc;
    if (!inGrid(si, sj)) { si = hc; sj = hc + hubR + 1; }

    this._edgeSym(state, hc + hubR, hc, si, sj);
    const stack = [[si, sj]];
    this._markSym(state, si, sj);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Klassischer rekursiver Backtracker, hier iterativ mit explizitem Stack.
    while (stack.length) {
      const [i, j] = stack[stack.length - 1];
      const neighbours = [];
      for (const [dx, dy] of dirs) {
        const ni = i + dx, nj = j + dy;
        if (inGrid(ni, nj) && !visited[flat(ni, nj)]) neighbours.push([ni, nj]);
      }
      if (!neighbours.length) { stack.pop(); continue; }
      const [ni, nj] = neighbours[(rng() * neighbours.length) | 0];
      this._edgeSym(state, i, j, ni, nj);
      this._markSym(state, ni, nj);
      stack.push([ni, nj]);
    }

    // Mehrere Ausgänge aus dem Zentrum öffnen.
    for (const jj of [hc - hubR, hc, hc + hubR]) {
      if (inGrid(hc + hubR + 1, jj) && room[flat(hc + hubR + 1, jj)] < 0) {
        this._edgeSym(state, hc + hubR, jj, hc + hubR + 1, jj);
      }
    }
  },

  // ── Verschlingen: zusätzliche Verbindungen, weniger Sackgassen ────
  _addBraiding(state) {
    const { M, room, flat, braid, inGrid, seed } = state;
    if (!braid) return;
    const rng = MazeRecon.RNG.forPhase(seed, 'braid');
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        if (room[flat(i, j)] >= 0) continue;
        if (rng() < braid) {
          const open = dirs.filter(([dx, dy]) => inGrid(i + dx, j + dy) && room[flat(i + dx, j + dy)] < 0);
          if (open.length) {
            const [dx, dy] = open[(rng() * open.length) | 0];
            this._edgeSym(state, i, j, i + dx, j + dy);
          }
        }
      }
    }
  },

  // ── Ring-Verbindungen: symmetrische Schleifen um das Zentrum ──────
  _addRings(state) {
    const { M, hc, hubR, rings, room, flat, inGrid } = state;
    if (!rings) return;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let r = 0; r < rings; r++) {
      const rr = hubR + 2 + (rings > 1
        ? Math.round(r * (M * 0.46 - (hubR + 2)) / (rings - 1))
        : ((M * 0.46 - (hubR + 2)) / 2 | 0));

      for (let i = hc - rr; i <= hc + rr; i++) {
        for (let j = hc - rr; j <= hc + rr; j++) {
          if (Math.max(Math.abs(i - hc), Math.abs(j - hc)) !== rr) continue;
          if (!inGrid(i, j) || room[flat(i, j)] >= 1) continue;
          this._markSym(state, i, j);
          for (const [dx, dy] of dirs) {
            const ni = i + dx, nj = j + dy;
            if (!inGrid(ni, nj) || room[flat(ni, nj)] >= 1) continue;
            if (Math.max(Math.abs(ni - hc), Math.abs(nj - hc)) === rr) {
              this._edgeSym(state, i, j, ni, nj);
            }
          }
        }
      }
    }
  },

  // ── Basis-Ausgänge: je ein Tor Richtung Zentrum ───────────────────
  _addBaseGates(state) {
    const { hc, sym, bases, room, flat, inGrid } = state;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Nur je ein Repräsentant pro Symmetriegruppe; der Rest folgt durch Drehung.
    for (let a = 0; a * sym < bases.length; a++) {
      const base = bases[a * sym];
      let best = null, bestDist = Infinity;
      for (const [bi, bj] of base.cells) {
        for (const [dx, dy] of dirs) {
          const ni = bi + dx, nj = bj + dy;
          if (!inGrid(ni, nj) || room[flat(ni, nj)] >= 0) continue;
          const d = Math.hypot(ni - hc, nj - hc);
          if (d < bestDist) { bestDist = d; best = [bi, bj, ni, nj]; }
        }
      }
      if (best) {
        this._edgeSym(state, best[0], best[1], best[2], best[3]);
        // "front" = das Feld direkt vor dem Basistor (für Wasser/Reparatur).
        let fx = best[2], fy = best[3];
        for (let k = 0; k < sym; k++) {
          if (bases[a * sym + k]) bases[a * sym + k].front = [fx, fy];
          [fx, fy] = this._rotCell(state, fx, fy);
        }
      }
    }
  },

  // ── Rastern: logisches Labyrinth in das gezeichnete Gitter übertragen ──
  _rasterize(state) {
    const { M, grid, visited, room, flat, edges, idx, cell } = state;
    const T = MazeRecon.Tile;

    // Besuchte Zellen als Boden/Hub/Basis setzen.
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        if (visited[flat(i, j)]) {
          const r = room[flat(i, j)];
          grid[idx(cell(i), cell(j))] = r === 0 ? T.HUB : r >= 1 ? T.BASE : T.FLOOR;
        }
      }
    }

    // Jede offene Kante als Durchgang zwischen zwei Zellen öffnen.
    for (const e of edges) {
      const [p, q] = e.split('|').map(Number);
      const ax = (p / M) | 0, ay = p % M, bx = (q / M) | 0, by = q % M;
      const wx = cell(ax) + (bx - ax), wy = cell(ay) + (by - ay);
      if (grid[idx(wx, wy)] === T.WALL) grid[idx(wx, wy)] = T.FLOOR;
    }
  },

  // ── Ergebnis als Modell verpacken ─────────────────────────────────
  _pack(state) {
    return {
      grid: state.grid, W: state.W, M: state.M, R: state.sym,
      idx: state.idx, cell: state.cell,
      bases: state.bases,
      hub: [state.hc, state.hc], hubR: state.hubR,
      room: state.room, edges: state.edges,
      flat: state.flat, inGrid: state.inGrid,
      scavZones: state.scavZones
    };
  }
};

/* =========================================================================
 *  5. NACHBEARBEITUNG
 *     Routen hervorheben, Wasser fluten, Erreichbarkeit reparieren,
 *     Plätze freiräumen, Ressourcen und Scavenger setzen.
 * ========================================================================= */

MazeRecon.Post = {

  // ── Nachbarschaftsgraph der Zellen ────────────────────────────────
  // Verbindet begehbare Nachbarzellen. Mit groundOnly zählt Wasser als Sperre.
  buildGraph(model, groundOnly) {
    const { M, grid, idx, cell, flat, inGrid } = model;
    const T = MazeRecon.Tile;
    const canPass = (x, y) => {
      const v = grid[idx(x, y)];
      return v !== T.WALL && (!groundOnly || v !== T.WATER);
    };
    const adj = Array.from({ length: M * M }, () => []);

    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        if (!canPass(cell(i), cell(j))) continue;
        // Nur nach rechts/unten prüfen – Kanten werden beidseitig eingetragen.
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          if (!canPass(cell(ni), cell(nj))) continue;
          const between = grid[idx(cell(i) + dx, cell(j) + dy)];
          if (between === T.WALL || between === T.WATER) continue;
          adj[flat(i, j)].push(flat(ni, nj));
          adj[flat(ni, nj)].push(flat(i, j));
        }
      }
    }
    return adj;
  },

  /** Kürzester Pfad per Breitensuche (BFS); null wenn unerreichbar. */
  shortestPath(adj, src, dst) {
    const prev = new Int32Array(adj.length).fill(-1);
    const seen = new Uint8Array(adj.length);
    const q = [src];
    seen[src] = 1;
    prev[src] = src;
    while (q.length) {
      const u = q.shift();
      if (u === dst) break;
      for (const v of adj[u]) {
        if (!seen[v]) { seen[v] = 1; prev[v] = u; q.push(v); }
      }
    }
    if (!seen[dst]) return null;
    const path = [];
    let u = dst;
    while (u !== src) { path.push(u); u = prev[u]; }
    path.push(src);
    return path.reverse();
  },

  // ── Hauptrouten markieren (Basis → Zentrum) ───────────────────────
  markMainRoutes(model) {
    const { M, grid, W, idx, cell, flat, R } = model;
    const T = MazeRecon.Tile;
    const adj = this.buildGraph(model, false);
    const hubIdx = flat(model.hub[0], model.hub[1]);
    const tagged = [];

    const tag = (x, y) => {
      if (grid[idx(x, y)] === T.FLOOR) { grid[idx(x, y)] = T.MAIN; tagged.push([x, y]); }
    };

    // Für je einen Repräsentanten pro Symmetriegruppe den Pfad zum Hub färben.
    for (let a = 0; a * R < model.bases.length; a++) {
      const b = model.bases[a * R];
      const path = this.shortestPath(adj, flat(b.ci, b.cj), hubIdx);
      if (!path) continue;
      for (let k = 0; k < path.length; k++) {
        const n = path[k], i = (n / M) | 0, j = n % M;
        tag(cell(i), cell(j));
        if (k > 0) {
          // auch das Durchgangsfeld zwischen den beiden Zellen färben
          const pn = path[k - 1], pi = (pn / M) | 0, pj = pn % M;
          tag(cell(pi) + (i - pi), cell(pj) + (j - pj));
        }
      }
    }

    // Markierung auf alle Drehbilder spiegeln.
    const rot = (x, y) => R === 4 ? [W - 1 - y, x] : [W - 1 - x, W - 1 - y];
    for (const [x, y] of tagged) {
      let rx = x, ry = y;
      for (let k = 1; k < R; k++) {
        [rx, ry] = rot(rx, ry);
        if (grid[idx(rx, ry)] === T.FLOOR) grid[idx(rx, ry)] = T.MAIN;
      }
    }
  },

  // ── Wasser fluten ─────────────────────────────────────────────────
  floodWater(model, cfg) {
    const { M, grid, idx, cell, room, flat, inGrid, R } = model;
    const T = MazeRecon.Tile;
    const hc = model.hub[0], hubR = model.hubR;
    const rng = MazeRecon.RNG.forPhase(cfg.seed, 'water');
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Felder direkt vor den Basen bleiben immer trocken.
    const dry = new Set();
    for (const b of model.bases) {
      if (b.front) {
        for (const [mi, mj] of MazeRecon.Symmetry.images(b.front[0], b.front[1], M, R)) {
          dry.add(mi + ',' + mj);
        }
      }
    }

    const canFlood = (i, j) => {
      if (!inGrid(i, j) || room[flat(i, j)] >= 0) return false;
      if (Math.hypot(i - hc, j - hc) < hubR + 2) return false;
      if (dry.has(i + ',' + j)) return false;
      return grid[idx(cell(i), cell(j))] === T.FLOOR;
    };

    // Von einem Startfeld aus einen kleinen zusammenhängenden Klecks wachsen lassen.
    const grow = (si, sj, n) => {
      const out = [], seen = new Set([si + ',' + sj]), q = [[si, sj]];
      while (q.length && out.length < n) {
        const [i, j] = q.shift();
        if (!canFlood(i, j)) continue;
        out.push([i, j]);
        for (const [dx, dy] of dirs) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          if (grid[idx(cell(i) + dx, cell(j) + dy)] === T.WALL) continue;
          const k = ni + ',' + nj;
          if (!seen.has(k)) { seen.add(k); q.push([ni, nj]); }
        }
      }
      return out;
    };

    const nBlobs = Math.round(M * 0.45 * cfg.waterW);
    for (let b = 0; b < nBlobs; b++) {
      let fi = -1, fj = -1, tries = 0;
      while (tries++ < 40) {
        const i = 2 + ((rng() * (M - 4)) | 0), j = 2 + ((rng() * (M - 4)) | 0);
        if (canFlood(i, j)) { fi = i; fj = j; break; }
      }
      if (fi < 0) continue;
      const blob = grow(fi, fj, 1 + ((rng() * 4) | 0));
      for (const [bi, bj] of blob) {
        for (const [mi, mj] of MazeRecon.Symmetry.images(bi, bj, M, R)) {
          if (!inGrid(mi, mj) || room[flat(mi, mj)] >= 0 || dry.has(mi + ',' + mj)) continue;
          const w = idx(cell(mi), cell(mj));
          if (grid[w] === T.FLOOR) grid[w] = T.WATER;
        }
      }
    }

    // Durchgangsfelder zwischen zwei Wasserzellen ebenfalls fluten.
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        if (grid[idx(cell(i), cell(j))] !== T.WATER) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          if (grid[idx(cell(ni), cell(nj))] === T.WATER) {
            grid[idx(cell(i) + dx, cell(j) + dy)] = T.WATER;
          }
        }
      }
    }
  },

  // ── Erreichbarkeit reparieren ─────────────────────────────────────
  // Stellt sicher, dass jede Basis das Zentrum erreicht; bricht notfalls
  // Wände durch (Wasser wird dabei zu Brücken).
  repairConnectivity(model) {
    const { grid, M, idx, cell, flat, inGrid, room, R } = model;
    const T = MazeRecon.Tile;
    const hc = model.hub[0];

    const passable = (x, y) => { const v = grid[idx(x, y)]; return v !== T.WALL && v !== T.WATER; };
    const open = v => v === T.WATER ? T.BRIDGE : (v === T.WALL ? T.FLOOR : v);

    const openCell = (i, j) => {
      for (const [mi, mj] of MazeRecon.Symmetry.images(i, j, M, R)) {
        grid[idx(cell(mi), cell(mj))] = open(grid[idx(cell(mi), cell(mj))]);
      }
    };
    const openEdge = (ai, aj, bi, bj) => {
      const A = MazeRecon.Symmetry.images(ai, aj, M, R), B = MazeRecon.Symmetry.images(bi, bj, M, R);
      for (let k = 0; k < R; k++) {
        const [ax, ay] = A[k], [bx, by] = B[k];
        grid[idx(cell(ax), cell(ay))] = open(grid[idx(cell(ax), cell(ay))]);
        grid[idx(cell(bx), cell(by))] = open(grid[idx(cell(bx), cell(by))]);
        grid[idx(cell(ax) + (bx - ax), cell(ay) + (by - ay))] =
          open(grid[idx(cell(ax) + (bx - ax), cell(ay) + (by - ay))]);
      }
    };

    // Flutfüllung vom Zentrum: welche Zellen sind erreichbar?
    const flood = () => {
      const seen = new Uint8Array(M * M), s = flat(hc, hc), q = [s];
      seen[s] = 1;
      while (q.length) {
        const u = q.shift(), i = (u / M) | 0, j = u % M;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          if (passable(cell(ni), cell(nj)) && passable(cell(i) + dx, cell(j) + dy) && !seen[flat(ni, nj)]) {
            seen[flat(ni, nj)] = 1;
            q.push(flat(ni, nj));
          }
        }
      }
      return seen;
    };

    let reachable = flood();
    for (const b of model.bases) {
      const f = b.front || [b.ci, b.cj], s = flat(f[0], f[1]);
      openCell(f[0], f[1]);
      if (reachable[s]) continue;

      // BFS (auch durch Wände) zum nächstgelegenen erreichbaren Feld …
      const prev = new Int32Array(M * M).fill(-1), seen = new Uint8Array(M * M), q = [s];
      seen[s] = 1;
      let hit = -1;
      while (q.length) {
        const u = q.shift();
        if (reachable[u]) { hit = u; break; }
        const i = (u / M) | 0, j = u % M;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          const nk = flat(ni, nj);
          if (seen[nk] || room[nk] >= 1) continue;
          seen[nk] = 1; prev[nk] = u; q.push(nk);
        }
      }
      if (hit < 0) continue;
      // … und entlang dieses Pfades alles aufbrechen.
      let u = hit;
      while (u !== s) {
        const p = prev[u];
        const i = (u / M) | 0, j = u % M, pi = (p / M) | 0, pj = p % M;
        openEdge(pi, pj, i, j);
        u = p;
      }
      reachable = flood();
    }
  },

  // ── Plätze freiräumen (Zentrum & Ecken) ───────────────────────────
  carvePlazas(model) {
    const { M, W, grid, idx, cell, flat, inGrid, room, R } = model;
    const T = MazeRecon.Tile;
    const hc = model.hub[0];
    const clear = v => (v === T.WALL || v === T.WATER) ? T.FLOOR : v;
    const wRot = (x, y) => R === 4 ? [W - 1 - y, x] : [W - 1 - x, W - 1 - y];

    const openC = (i, j) => {
      for (const [mi, mj] of MazeRecon.Symmetry.images(i, j, M, R)) {
        if (!inGrid(mi, mj) || room[flat(mi, mj)] >= 1) continue;
        grid[idx(cell(mi), cell(mj))] = clear(grid[idx(cell(mi), cell(mj))]);
      }
    };
    const openE = (ai, aj, bi, bj) => {
      const A = MazeRecon.Symmetry.images(ai, aj, M, R), B = MazeRecon.Symmetry.images(bi, bj, M, R);
      for (let k = 0; k < R; k++) {
        const [ax, ay] = A[k], [bx, by] = B[k];
        if (!inGrid(ax, ay) || !inGrid(bx, by)) continue;
        if (room[flat(ax, ay)] >= 1 || room[flat(bx, by)] >= 1) continue;
        grid[idx(cell(ax) + (bx - ax), cell(ay) + (by - ay))] = clear(grid[idx(cell(ax) + (bx - ax), cell(ay) + (by - ay))]);
      }
    };
    const openP = (i, j) => {
      let px = cell(i) + 1, py = cell(j) + 1;
      for (let k = 0; k < R; k++) { grid[idx(px, py)] = clear(grid[idx(px, py)]); [px, py] = wRot(px, py); }
    };

    const lo = 4, hi = M - 5, rad = 2;

    // Platz rund ums Zentrum.
    for (let i = hc - model.hubR; i < hc + model.hubR; i++) {
      for (let j = hc - model.hubR; j < hc + model.hubR; j++) openP(i, j);
    }

    // Platz an den Eck-Ressourcenfeldern (Anzahl je nach Symmetrie).
    const seeds = R === 4 ? [[lo, lo]] : R === 2 ? [[lo, lo], [lo, hi]] : [[lo, lo], [lo, hi], [hi, lo], [hi, hi]];
    for (const [si, sj] of seeds) {
      for (let i = si - rad; i <= si + rad; i++) {
        for (let j = sj - rad; j <= sj + rad; j++) openC(i, j);
      }
      for (let i = si - rad; i <= si + rad; i++) {
        for (let j = sj - rad; j <= sj + rad; j++) {
          if (i + 1 <= si + rad) openE(i, j, i + 1, j);
          if (j + 1 <= sj + rad) openE(i, j, i, j + 1);
          if (i + 1 <= si + rad && j + 1 <= sj + rad) openP(i, j);
        }
      }
    }
  },

  // ── Ressourcen setzen (Öl) ────────────────────────────────────────
  placeResources(model, cfg) {
    const { M, grid, idx, cell, flat, inGrid, R } = model;
    const T = MazeRecon.Tile;
    const hc = model.hub[0], hubR = model.hubR;
    const placed = [];

    const passable = (x, y) => { const v = grid[idx(x, y)]; return v !== T.WALL && v !== T.WATER; };

    // Erreichbarkeit vom Zentrum vorab bestimmen – Ressourcen nur dort.
    const reachable = new Uint8Array(M * M);
    {
      const s = flat(hc, hc), q = [s];
      reachable[s] = 1;
      while (q.length) {
        const u = q.shift(), i = (u / M) | 0, j = u % M;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + dx, nj = j + dy;
          if (!inGrid(ni, nj)) continue;
          if (passable(cell(ni), cell(nj)) && passable(cell(i) + dx, cell(j) + dy) && !reachable[flat(ni, nj)]) {
            reachable[flat(ni, nj)] = 1;
            q.push(flat(ni, nj));
          }
        }
      }
    }

    const canPut = (i, j) => {
      if (!inGrid(i, j) || !reachable[flat(i, j)]) return false;
      const v = grid[idx(cell(i), cell(j))];
      return v === T.FLOOR || v === T.MAIN || v === T.HUB;
    };

    const put = (i, j) => {
      for (const [mi, mj] of MazeRecon.Symmetry.images(i, j, M, R)) {
        if (canPut(mi, mj)) { grid[idx(cell(mi), cell(mj))] = T.RESOURCE; placed.push([cell(mi), cell(mj)]); }
      }
    };

    // Ring aus Ressourcen rund ums Zentrum.
    const rC = Math.max(1, hubR - 1);
    for (let i = hc - rC; i <= hc + rC; i++) {
      for (let j = hc - rC; j <= hc + rC; j++) {
        if (Math.max(Math.abs(i - hc), Math.abs(j - hc)) === rC && canPut(i, j)) put(i, j);
      }
    }

    // Felder aus Ressourcen in den Ecken (schachbrettartig, max. 6 pro Ecke).
    const lo = 4, hi = M - 5, rad = 2;
    const seeds = R === 4 ? [[lo, lo]] : R === 2 ? [[lo, lo], [lo, hi]] : [[lo, lo], [lo, hi], [hi, lo], [hi, hi]];
    for (const [cx, cy] of seeds) {
      let n = 0;
      for (let i = cx - rad; i <= cx + rad && n < 6; i++) {
        for (let j = cy - rad; j <= cy + rad && n < 6; j++) {
          if ((i + j) % 2 === 0 && canPut(i, j)) { put(i, j); n++; }
        }
      }
    }
    return placed;
  },

  // ── Scavenger-Camps platzieren ────────────────────────────────────
  placeScavengers(model) {
    const { M, grid, idx, cell, flat, inGrid, room, R, scavZones } = model;
    if (!scavZones || !scavZones.length) return [];

    const T = MazeRecon.Tile;
    const hc = model.hub[0];
    const camps = [];

    const isFloor = (x, y) => {
      const v = grid[idx(x, y)];
      return v === T.FLOOR || v === T.MAIN;
    };
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (const [szI, szJ] of scavZones) {
      // Bestes 2×2-Plätzchen nahe der Zone suchen: weit weg vom Zentrum,
      // wenig Anbindung (eher Sackgasse).
      let bestI = -1, bestJ = -1, bestScore = -1;
      for (let di = -3; di <= 3; di++) {
        for (let dj = -3; dj <= 3; dj++) {
          const i = szI + di, j = szJ + dj;
          if (!inGrid(i, j) || !inGrid(i + 1, j + 1)) continue;
          if (room[flat(i, j)] >= 0 || room[flat(i + 1, j)] >= 0 ||
              room[flat(i, j + 1)] >= 0 || room[flat(i + 1, j + 1)] >= 0) continue;
          if (!isFloor(cell(i), cell(j)) || !isFloor(cell(i + 1), cell(j)) ||
              !isFloor(cell(i), cell(j + 1)) || !isFloor(cell(i + 1), cell(j + 1))) continue;

          const dist = Math.hypot(i - hc, j - hc);
          let conn = 0;
          for (const [dx, dy] of dirs) {
            const ni = i + dx, nj = j + dy;
            if (inGrid(ni, nj) && isFloor(cell(ni), cell(nj))) conn++;
          }
          const score = dist * 2 - conn * 3;
          if (score > bestScore) { bestScore = score; bestI = i; bestJ = j; }
        }
      }
      if (bestI < 0) continue;

      // An allen Drehbildern das 2×2-Camp setzen.
      for (const [mi, mj] of MazeRecon.Symmetry.images(bestI, bestJ, M, R)) {
        if (!inGrid(mi, mj) || !inGrid(mi + 1, mj + 1)) continue;
        if (room[flat(mi, mj)] >= 0 || room[flat(mi + 1, mj)] >= 0 ||
            room[flat(mi, mj + 1)] >= 0 || room[flat(mi + 1, mj + 1)] >= 0) continue;

        for (let dx = 0; dx < 2; dx++) {
          for (let dy = 0; dy < 2; dy++) {
            const ci = mi + dx, cj = mj + dy;
            if (grid[idx(cell(ci), cell(cj))] === T.FLOOR ||
                grid[idx(cell(ci), cell(cj))] === T.MAIN) {
              grid[idx(cell(ci), cell(cj))] = T.SCAVENGER;
            }
          }
        }
        camps.push({ ci: mi, cj: mj });
      }
    }
    return camps;
  }

};

/* =========================================================================
 *  6. VALIDIERUNG
 *     Prüft die fertige Karte auf Erreichbarkeit, unabhängige Routen,
 *     Abstände und Fairness und liefert eine Liste von Checks zurück.
 * ========================================================================= */

MazeRecon.Validate = {

  // Max-Flow (Edmonds-Karp) – zählt kantendisjunkte Wege src → dst, max. 6.
  maxFlow(adj, src, dst) {
    const n = adj.length, to = [], cap = [], next = [], head = new Int32Array(n).fill(-1);
    const add = (u, v, c) => { to.push(v); cap.push(c); next.push(head[u]); head[u] = to.length - 1; };
    for (let u = 0; u < n; u++) for (const v of adj[u]) { add(u, v, 1); add(v, u, 0); }

    let flow = 0;
    while (flow <= 6) {
      const pe = new Int32Array(n).fill(-1), vis = new Uint8Array(n), q = [src];
      vis[src] = 1;
      while (q.length) {
        const u = q.shift();
        for (let e = head[u]; e !== -1; e = next[e]) {
          const v = to[e];
          if (!vis[v] && cap[e] > 0) { vis[v] = 1; pe[v] = e; q.push(v); }
        }
      }
      if (!vis[dst]) break;
      let v = dst;
      while (v !== src) { const e = pe[v]; cap[e]--; cap[e ^ 1]++; v = to[e ^ 1]; }
      flow++;
    }
    return flow;
  },

  run(model, cfg) {
    const adj = MazeRecon.Post.buildGraph(model, true);
    const hubI = model.flat(model.hub[0], model.hub[1]);
    const baseI = model.bases.map(b => model.flat(...(b.front || [b.ci, b.cj])));

    // BFS-Distanzkarte ab einer Quelle.
    const distMap = (src) => {
      const d = new Int32Array(adj.length).fill(-1), q = [src];
      d[src] = 0;
      while (q.length) {
        const u = q.shift();
        for (const v of adj[u]) if (d[v] < 0) { d[v] = d[u] + 1; q.push(v); }
      }
      return d;
    };

    const dh = distMap(hubI);
    const out = [];

    // V1 – jede Basis erreicht das Zentrum.
    const reach = baseI.map(b => dh[b] >= 0);
    out.push({ code: 'V1', name: 'Alle Basen ↔ Zentrum', pass: reach.every(Boolean), value: `${reach.filter(Boolean).length}/${baseI.length}`, thr: 'all' });

    // V2 – alle Basen untereinander verbunden.
    const d0 = distMap(baseI[0]);
    const conn = baseI.every(b => d0[b] >= 0);
    out.push({ code: 'V2', name: 'Basen verbunden', pass: conn, value: conn ? 'yes' : 'no', thr: 'yes' });

    // V3 – Mindestzahl unabhängiger Routen zum Zentrum.
    let minR = Infinity;
    for (const b of baseI) minR = Math.min(minR, this.maxFlow(adj, b, hubI));
    out.push({ code: 'V3', name: 'Unabh. Routen → Zentrum', pass: minR >= cfg.vRoutes, value: `${minR}`, thr: `≥ ${cfg.vRoutes}` });

    // V4 – Mindestabstand zwischen zwei Basen (Luftlinie).
    let minD = Infinity;
    for (let a = 0; a < model.bases.length; a++) {
      for (let b = a + 1; b < model.bases.length; b++) {
        const A = model.bases[a], B = model.bases[b];
        minD = Math.min(minD, Math.hypot(A.ci - B.ci, A.cj - B.cj));
      }
    }
    out.push({ code: 'V4', name: 'Min. Basis-Abstand', pass: minD >= cfg.vDist, value: `${minD.toFixed(1)} Z`, thr: `≥ ${cfg.vDist}` });

    // V5 – kürzester Laufweg Basis → Basis (Schutz gegen frühen Rush).
    let minP = Infinity;
    for (let a = 0; a < baseI.length; a++) {
      const ds = distMap(baseI[a]);
      for (let b = 0; b < baseI.length; b++) if (a !== b && ds[baseI[b]] >= 0) minP = Math.min(minP, ds[baseI[b]]);
    }
    out.push({ code: 'V5', name: 'Min. Weg Basis→Basis', pass: minP >= cfg.vRush, value: `${minP} Z`, thr: `≥ ${cfg.vRush}` });

    // V6 – Fairness: Variationskoeffizient der Distanzen zum Zentrum.
    const lens = baseI.map(b => dh[b]).filter(x => x >= 0);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const cv = mean > 0 ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) / mean : 0;
    out.push({ code: 'V6', name: 'Fairness (VK)', pass: cv <= cfg.vFair, value: cv.toFixed(3), thr: `≤ ${cfg.vFair}` });

    // V7 – alle Ressourcen erreichbar.
    const G = model.grid, ix = model.idx, cc = model.cell;
    const resC = [];
    for (let i = 0; i < model.M; i++) {
      for (let j = 0; j < model.M; j++) {
        if (G[ix(cc(i), cc(j))] === MazeRecon.Tile.RESOURCE) resC.push(model.flat(i, j));
      }
    }
    const resR = resC.filter(r => dh[r] >= 0).length;
    out.push({ code: 'V7', name: 'Ressourcen erreichbar', pass: resC.length > 0 && resR === resC.length, value: `${resR}/${resC.length}`, thr: 'all' });

    // V8 – kürzester Pfad Basis → Zentrum lang genug.
    const lens2 = baseI.map(b => dh[b]).filter(x => x >= 0);
    const minRL = lens2.length ? Math.min(...lens2) : 0;
    out.push({ code: 'V8', name: 'Weg Basis→Zentrum', pass: minRL >= cfg.minResRoute, value: `${minRL} Z`, thr: `≥ ${cfg.minResRoute}` });

    return { checks: out, stats: { minD, minP, minR, cv, resources: resC.length, minRoute: minRL } };
  }

};

/* =========================================================================
 *  7. RENDERER
 *     Zeichnet das Modell als Vorschau auf das <canvas>.
 * ========================================================================= */

MazeRecon.Render = {

  draw(model) {
    const canvas = document.getElementById('map');
    const ctx = canvas.getContext('2d');
    const { grid, W, idx, cell: ci } = model;
    const T = MazeRecon.Tile;
    const px = Math.max(6, Math.round(620 / W));   // Pixel pro Gitterfeld

    canvas.width = W * px;
    canvas.height = W * px;

    // 1) Grundraster: jedes Feld in seiner Kachelfarbe.
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const v = grid[idx(x, y)];
        const c = MazeRecon.Colors[v] || MazeRecon.Colors[0];
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(x * px, y * px, px + 1, px + 1);
      }
    }

    // 2) Spielerbasen als farbige Ringe.
    for (const b of model.bases) {
      const cx = (ci(b.ci) + 0.5) * px, cy = (ci(b.cj) + 0.5) * px;
      const col = MazeRecon.PlayerColors[b.player % MazeRecon.PlayerColors.length];
      const r = px * 1.4;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, 2, 0, 2 * Math.PI); ctx.fill();
    }

    // 3) Scavenger-Camps als graue Quadrate.
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[idx(x, y)] === T.SCAVENGER) {
          const cx = (x + 0.5) * px, cy = (y + 0.5) * px, s = px * 0.55;
          ctx.fillStyle = MazeRecon.ScavColor;
          ctx.strokeStyle = '#5a5550'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.rect(cx - s, cy - s, s * 2, s * 2); ctx.fill(); ctx.stroke();
        }
      }
    }

    // 4) Ressourcen als grüne Rauten.
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[idx(x, y)] === T.RESOURCE) {
          const cx = (x + 0.5) * px, cy = (y + 0.5) * px, r = px * 0.42;
          ctx.fillStyle = '#56b06e'; ctx.strokeStyle = '#0c1f15'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy);
          ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#0c1f15';
          ctx.beginPath(); ctx.arc(cx, cy, px * 0.12, 0, 2 * Math.PI); ctx.fill();
        }
      }
    }
  }

};

/* =========================================================================
 *  8. WARZONE-2100-EXPORT (.wz)
 *     Eine .wz-Datei ist ein ZIP mit Map-, Terrain- und Objektdateien.
 *     Hier wird das ZIP von Hand (ohne Komprimierung) zusammengebaut.
 * ========================================================================= */

MazeRecon.Export = (function() {

  const WZ = {
    GROUND_TEX: 2, WATER_TEX: 13, WALL_TEX: 18,
    DATASET: 'MULTI_CAM_1', TILE: 128,
    TERRAIN: [1,0,2,2,0,2,2,2,2,1,1,1,0,7,7,7,7,7,8,6,4,4,6,3,3,3,2,4,1,4,
      7,7,7,7,4,4,2,2,2,2,1,4,0,4,4,8,8,2,4,4,4,4,4,4,4,9,9,6,9,6,
      4,4,9,9,9,9,9,9,9,9,9,8,4,4,4,8,5,6,2,2,2,2,2,2,2,2,2,2,2,0,0,0,0,0,0,0]
  };

  // CRC32-Tabelle (für ZIP-Prüfsummen).
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Baut ein unkomprimiertes ZIP (Methode "stored") aus { name, data }-Einträgen.
  function zip(files) {
    const enc = new TextEncoder(), chunks = [], central = [];
    let off = 0;
    const u16 = v => [v & 255, (v >> 8) & 255];
    const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

    // Lokale Header + Daten.
    for (const f of files) {
      const nb = enc.encode(f.name), cs = crc32(f.data);
      const lh = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(cs), u32(f.data.length), u32(f.data.length), u16(nb.length), u16(0)
      );
      chunks.push(new Uint8Array(lh), nb, f.data);
      central.push({ name: nb, crc: cs, size: f.data.length, offset: off });
      off += lh.length + nb.length + f.data.length;
    }

    // Zentrales Verzeichnis.
    const dir = []; let ds = 0; const dsOff = off;
    for (const e of central) {
      const h = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset)
      );
      dir.push(new Uint8Array(h), e.name);
      ds += h.length + e.name.length;
    }

    // Abschluss-Record + alles zusammenfügen.
    const eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(ds), u32(dsOff), u16(0)));
    const all = [...chunks, ...dir, eocd];
    let total = 0; for (const p of all) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0; for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // Kleiner Helfer zum Schreiben von Little-Endian-Binärdaten.
  function writer() {
    const a = [];
    return {
      u8:  v => a.push(v & 255),
      u16: v => a.push(v & 255, (v >> 8) & 255),
      u32: v => a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255),
      str: s => { for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 255); },
      out: () => new Uint8Array(a)
    };
  }

  // game.map: Textur + Höhe je WZ-Kachel (die Karte wird um `scale` vergrößert).
  function gameMap(model, flatSet, scale, wallH, groundH, waterH) {
    const { W, grid, idx } = model, T = MazeRecon.Tile, S = W * scale;
    const w = writer();
    w.str('map '); w.u32(10); w.u32(S); w.u32(S);
    for (let ty = 0; ty < S; ty++) {
      for (let tx = 0; tx < S; tx++) {
        const cx = (tx / scale) | 0, cy = (ty / scale) | 0, key = cx + ',' + cy;
        if (flatSet.has(key)) { w.u16(WZ.GROUND_TEX & 0x1FF); w.u8(groundH); continue; }
        const cellVal = grid[idx(cx, cy)];
        let tex = WZ.GROUND_TEX, ht = groundH;
        if (cellVal === T.WATER)     { tex = WZ.WATER_TEX; ht = waterH; }
        else if (cellVal === T.WALL) { tex = WZ.WALL_TEX;  ht = wallH; }
        w.u16(tex & 0x1FF); w.u8(ht);
      }
    }
    w.u32(1); w.u32(0);
    return w.out();
  }

  function terrainTypes() {
    const w = writer();
    w.str('ttyp'); w.u32(8); w.u32(WZ.TERRAIN.length);
    for (const t of WZ.TERRAIN) w.u16(t);
    return w.out();
  }

  function gameFile(w, h) {
    const wr = writer();
    wr.str('game'); wr.u32(8); wr.u32(0); wr.u32(0); wr.u32(0); wr.u32(0); wr.u32(w); wr.u32(h);
    for (let k = 0; k < 20; k++) wr.u8(0);
    return wr.out();
  }

  function levelFile(name, players) {
    return [`// WZ2100 Maze-Generator`, '', `level   ${name}`, `players ${players}`, 'type    14',
      `dataset ${WZ.DATASET}`, `game    "multiplay/maps/${name}.gam"`,
      `data    "wrf/multi/skirmish${players}.wrf"`, `data    "wrf/multi/fog1.wrf"`, ''].join('\n');
  }

  // Stellt Strukturen, Droiden und Features (Öl) je Basis/Scavenger zusammen.
  function basePlan(model, scale, hasScavs) {
    const { W, grid, idx, cell: ci } = model, T = MazeRecon.Tile;
    const flatSet = new Set();          // Kacheln, die platt/begehbar sein müssen
    let nextId = 1;
    const hs = Math.floor(scale / 2);
    const structs = {}, droids = {}, feats = {};
    let si = 0, di = 0, fi = 0;
    const inside = (x, y) => x >= 1 && y >= 1 && x < W - 1 && y < W - 1;

    const addS = (name, player, gx, gy, foot) => {
      structs['structure_' + (si++)] = {
        name, id: nextId,
        position: foot === 2 ? [gx * WZ.TILE, gy * WZ.TILE, 0] : [gx * WZ.TILE + 64, gy * WZ.TILE + 64, 0],
        rotation: [0], startpos: player
      };
      nextId++;
    };
    const addOil = (tx, ty) => {
      feats['feature_' + (fi++)] = { name: 'OilResource', id: nextId, position: [tx * WZ.TILE + 64, ty * WZ.TILE + 64, 0], rotation: [0] };
      nextId++;
    };
    const addTruck = (p, tx, ty) => {
      droids['droid_' + (di++)] = { template: 'ConstructionDroid', id: nextId, position: [tx * WZ.TILE + 64, ty * WZ.TILE + 64, 0], rotation: [0], startpos: p };
      nextId++;
    };

    // Pro Basis: Startgebäude, Öl und ein Bau-Truck.
    for (const b of model.bases) {
      const bx = ci(b.ci), by = ci(b.cj), p = b.player;
      for (let dx = -2; dx <= 3; dx++) for (let dy = -2; dy <= 3; dy++) { const tx = bx + dx, ty = by + dy; if (inside(tx, ty)) flatSet.add(tx + ',' + ty); }
      const gx = bx * scale + hs, gy = by * scale + hs;
      addS('A0CommandCentre', p, gx, gy, 2);
      addS('A0LightFactory', p, gx + 2, gy, 2);
      addS('A0PowerGenerator', p, gx, gy + 2, 2);
      addS('A0ResourceExtractor', p, gx + 1, gy + 1, 1);
      addOil(gx + 1, gy + 1);
      addTruck(p, gx + 1, gy - 2);
    }

    // Scavenger-Gebäude (eigener "Spieler" hinter den echten Spielern).
    if (hasScavs) {
      const scavPlayer = model.bases.length;
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          if (grid[idx(x, y)] === T.SCAVENGER) {
            const gx = x * scale + hs, gy = y * scale + hs;
            for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) { const tx = x + dx, ty = y + dy; if (inside(tx, ty)) flatSet.add(tx + ',' + ty); }
            // Nur an der oberen-linken Ecke jedes 2×2-Camps Gebäude setzen.
            if (grid[idx(x - 1, y)] !== T.SCAVENGER && grid[idx(x, y - 1)] !== T.SCAVENGER) {
              addS('A0ScavFactory', scavPlayer, gx, gy, 2);
              addS('A0ScavBoiler',  scavPlayer, gx + 1, gy, 1);
              addS('A0ScavLab',     scavPlayer, gx, gy + 1, 1);
              addTruck(scavPlayer, gx + 1, gy - 1);
            }
          }
        }
      }
    }

    // Verstreute Ressourcen als Öl-Features.
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (grid[idx(x, y)] === T.RESOURCE) addOil(x * scale + hs, y * scale + hs);

    return { flatSet, structs: JSON.stringify(structs), droids: JSON.stringify(droids), feats: JSON.stringify(feats) };
  }

  // Zusätzliche Metadatei (nicht von WZ benötigt, hilft beim Debuggen).
  function metadata(model, cfg, stats) {
    const { grid, W, M, cell: ci } = model, T = MazeRecon.Tile, res = [];
    for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) if (grid[model.idx(ci(i), ci(j))] === T.RESOURCE) res.push([i, j]);
    return {
      format: 'wz2100-mazegen', layout: cfg.layout, players: model.bases.length, seed: cfg.seed, W,
      grid: Array.from(grid), bases: model.bases.map(b => ({ player: b.player, cell: [b.ci, b.cj] })), resources: res,
      metrics: { resources: stats.resources }
    };
  }

  // Baut die .wz-Datei und löst den Download aus.
  function download(cached) {
    if (!cached) return;
    const enc = new TextEncoder(), { model, cfg, stats } = cached;
    const players = model.bases.length, W = model.W;
    const scale = Math.max(1, Math.min(cfg.scale || 3, Math.floor(256 / W)));
    const S = W * scale, name = `${players}c-Maze-${cfg.seed}`, dir = `multiplay/maps/${name}/`;
    const plan = basePlan(model, scale, cfg.scavMode);

    const files = [
      { name: `${name}.addon.lev`, data: enc.encode(levelFile(name, players)) },
      { name: `multiplay/maps/${name}.gam`, data: gameFile(S, S) },
      { name: `${dir}game.map`, data: gameMap(model, plan.flatSet, scale, cfg.wallHeight, cfg.groundHeight, 40) },
      { name: `${dir}ttypes.ttp`, data: terrainTypes() },
      { name: `${dir}struct.json`, data: enc.encode(plan.structs) },
      { name: `${dir}droid.json`, data: enc.encode(plan.droids) },
      { name: `${dir}feature.json`, data: enc.encode(plan.feats) },
      { name: 'map.json', data: enc.encode(JSON.stringify(metadata(model, cfg, stats))) },
    ];

    const z = zip(files), blob = new Blob([z], { type: 'application/octet-stream' }), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name + '.wz'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return { download };

})();

/* =========================================================================
 *  9. UI-STEUERUNG
 *     Liest die Bedienelemente, ruft die Pipeline auf, zeigt Vorschau,
 *     Status und die Validierungs-Checkliste an.
 * ========================================================================= */

MazeRecon.UI = (function() {

  const $ = id => document.getElementById(id);
  const val = id => +($(id)?.value ?? 0);
  const txt = id => String($(id)?.value ?? '');

  // Zustand der drei Umschalter (An/Aus).
  let mainOn = true, waterOn = true, scavOn = false;
  let cached = null;   // letztes erzeugtes Modell für den .wz-Download

  // Spieleranzahl: fester Wert oder seed-abhängig zufällig (2–9).
  function readPlayers() {
    const sel = $('players').value;
    if (sel !== 'rand') return +sel;
    return 2 + (Math.abs(MazeRecon.RNG.hash(txt('seed') + '·players')()) % 8);
  }

  // Alle Bedienelemente in ein Konfigurationsobjekt einlesen.
  function readConfig() {
    const seed = txt('seed') || '0', players = readPlayers();
    return {
      seed, players, R: 1, bpd: players, layout: `${players}P`, placement: 'random',
      cells:        val('cells'),
      scale:        val('scale'),
      wallHeight:   val('wallHeight'),
      groundHeight: val('groundHeight'),
      braid:        +($('braid')?.value ?? 0),
      rings:        val('rings'),
      hubR:         val('hubR'),
      baseR:        val('baseR'),
      waterW:       +($('waterW')?.value ?? 0),
      mainOn, waterOn, scavMode: scavOn,
      // Validierungs-Schwellen (realistisch für 21–51-Zellen-Karten gewählt).
      minResRoute: 12, vRoutes: 1, vDist: 4, vRush: 4, vFair: 1.0
    };
  }

  // Komplette Pipeline einmal durchlaufen und Ergebnis anzeigen.
  function generate() {
    const cfg = readConfig();
    const model = MazeRecon.Builder.build(cfg);

    if (cfg.mainOn)  MazeRecon.Post.markMainRoutes(model);
    if (cfg.waterOn) MazeRecon.Post.floodWater(model, cfg);
    MazeRecon.Post.repairConnectivity(model);
    MazeRecon.Post.carvePlazas(model);
    MazeRecon.Post.placeResources(model, cfg);
    if (cfg.scavMode) MazeRecon.Post.placeScavengers(model);

    const { checks, stats } = MazeRecon.Validate.run(model, cfg);
    MazeRecon.Render.draw(model);

    showVerdict(checks);
    showChecks(checks);

    $('statusText').textContent =
      `${model.bases.length} Spieler · ${stats.resources} Ressourcen · ` +
      `Pfad→Zentrum ${stats.minRoute}` +
      (cfg.scavMode ? ' · Scavenger ✓' : '');

    cached = { model, cfg, stats };
  }

  // Gesamturteil-Pill oben rechts.
  function showVerdict(checks) {
    const ok = checks.every(c => c.pass);
    const v = $('verdict');
    if (!v) return;
    v.textContent = ok ? '✓ Alles ok' : '⚠ Prüfen';
    v.className = 'pill ' + (ok ? 'ok' : 'bad');
  }

  // Detaillierte Checkliste, damit man sieht, WAS ggf. nicht passt.
  function showChecks(checks) {
    const box = $('checks');
    if (!box) return;
    box.innerHTML = checks.map(c =>
      `<span class="check ${c.pass ? 'ok' : 'bad'}" title="${c.name} (Soll ${c.thr})">` +
      `${c.pass ? '✓' : '✗'} ${c.name} <b>${c.value}</b></span>`
    ).join('');
  }

  // Vorab anzeigen, wie groß die exportierte Karte wird.
  function updateScaleHint() {
    const cells = val('cells'), W = 2 * cells + 1;
    const want = val('scale'), actual = Math.max(1, Math.min(want, Math.floor(256 / W)));
    const px = W * actual;
    $('scaleV').textContent = actual < want ? `${actual} (max)` : `${actual}`;
    $('scaleHint').innerHTML =
      `Ergebnis: <b>${px}×${px}</b> WZ-Kacheln, Gänge ${actual} Kacheln breit.` +
      (actual < want ? ' (auf 256 begrenzt)' : '');
  }

  // An/Aus-Umschalter (Segmented Buttons) verdrahten.
  function bindSeg(id, fn) {
    const btns = document.querySelectorAll('#' + id + ' button');
    btns.forEach(b => b.addEventListener('click', () => {
      btns.forEach(x => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      fn(b.dataset.v);
      generate();
    }));
  }

  // Schieberegler: Wertanzeige aktualisieren und neu generieren.
  ['cells', 'scale', 'wallHeight', 'groundHeight', 'braid', 'rings', 'hubR', 'baseR', 'waterW'].forEach(id => {
    const inp = $(id), lbl = $(id + 'V');
    if (!inp) return;
    const decimals = { braid: 2 };   // dieser Regler zeigt Nachkommastellen
    const update = () => {
      if (lbl) {
        const v = +inp.value;
        lbl.textContent = decimals[id] != null ? v.toFixed(decimals[id]) : String(v);
      }
    };
    inp.addEventListener('input', () => { update(); generate(); });
    update();
  });

  $('players')?.addEventListener('change', generate);
  $('seed')?.addEventListener('input', generate);
  $('reseed')?.addEventListener('click', () => { $('seed').value = Math.floor(Math.random() * 1e6); generate(); });
  $('gen')?.addEventListener('click', generate);
  $('scale')?.addEventListener('input', updateScaleHint);
  $('cells')?.addEventListener('input', updateScaleHint);
  $('dl')?.addEventListener('click', () => MazeRecon.Export.download(cached));

  bindSeg('mainSeg',  v => { mainOn  = v === 'on'; });
  bindSeg('waterSeg', v => { waterOn = v === 'on'; });
  bindSeg('scavSeg',  v => { scavOn  = v === 'on'; });

  return {
    start() {
      updateScaleHint();
      generate();
    }
  };

})();

/* =========================================================================
 *  10. START
 * ========================================================================= */

MazeRecon.UI.start();
