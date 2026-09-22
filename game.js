"use strict";
// Laya Invaders: you spawn the invaders, Laya decides which one the cannon goes after.
// The page builds the situation as facts (no "best" label) and asks Laya two typed questions
// per decision: which invader first (choice) and how much pressure the defense is under (score).
// A one-line rule (shoot what lands first) runs in shadow as the baseline, so you can see when
// Laya disagrees, and M swaps the brain to that rule to compare how many each one holds.

const params = new URLSearchParams(location.search);
const LANG = params.get("lang") === "pt" ? "pt" : "en";
const TEXT = {
  en: {
    brain: "BRAIN", target: "TARGET", probs: "MODEL PROBABILITIES", rulePicks: "RULE PICKS",
    agree: "LAYA AGREES WITH RULE", pressure: "PRESSURE", held: "HELD", ruleName: "Rule (lands first)",
    you: "YOU · INVADERS", energy: "energy", of: "of", none: "no invaders",
    brainLaya: "LAYA", brainRule: "RULE · lands first",
    levels: ["calm", "busy", "overwhelmed"],
    kinds: { runner: "runner", zigzag: "zigzag", tank: "tank" },
    keys: "CLICK a column to drop an invader · 1 2 3 pick the kind · M swap brain · T auto-attack · SPACE pause · R reset · +/- speed",
    loading: "Loading Laya…", failed: "Laya failed to load:", paused: "PAUSED", live: "LIVE",
  },
  pt: {
    brain: "CÉREBRO", target: "ALVO", probs: "PROBABILIDADES", rulePicks: "A REGRA ESCOLHE",
    agree: "LAYA CONCORDA COM A REGRA", pressure: "PRESSÃO", held: "SEGUROU", ruleName: "Regra (o que pousa primeiro)",
    you: "VOCÊ · INVASORES", energy: "energia", of: "de", none: "nenhum invasor",
    brainLaya: "LAYA", brainRule: "REGRA · pousa primeiro",
    levels: ["tranquila", "apertada", "sufocada"],
    kinds: { runner: "corredor", zigzag: "zigue-zague", tank: "tanque" },
    keys: "CLIQUE numa coluna pra soltar um invasor · 1 2 3 escolhe o tipo · M troca o cérebro · T ataque automático · ESPAÇO pausa · R reinicia · +/- velocidade",
    loading: "Carregando o Laya…", failed: "O Laya não carregou:", paused: "PAUSADO", live: "AO VIVO",
  },
}[LANG];

const COLS = 12, ROWS = 18, CELL = 34;
const C = {
  bg: "#0a0a0a", dim: "#2a2a2a", dot: "#1c1c1c", green: "#8ef1a4", orange: "#ff6933",
  fg: "#f5f0e6", muted: "#8f8676", sand: "#c4b8a0",
};
const KINDS = {
  runner: { hp: 1, every: 3, cost: 2, color: C.orange, zig: false },
  zigzag: { hp: 1, every: 4, cost: 3, color: C.sand, zig: true },
  tank: { hp: 3, every: 7, cost: 4, color: C.fg, zig: false },
};
const KIND_KEYS = { 1: "runner", 2: "zigzag", 3: "tank" };
const ENERGY_MAX = 12, ENERGY_EVERY = 6, COOLDOWN = 3, BULLET_SPEED = 2, MAX_OPTIONS = 5;
const LETTERS = "ABCDE";

// 8x8 sprites, one string per row.
const SPRITES = {
  runner: ["..X..X..", "...XX...", "..XXXX..", ".XX.XXX.", "XXXXXXXX", "X.XXXX.X", "X.X..X.X", "...XX..."],
  zigzag: ["...XX...", "..XXXX..", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", "..X..X..", ".X.XX.X.", "X.X..X.X"],
  tank: [".XXXXXX.", "XXXXXXXX", "XX.XX.XX", "XXXXXXXX", "XXXXXXXX", ".XX..XX.", "XX.XX.XX", "X......X"],
  cannon: ["...XX...", "...XX...", "..XXXX..", ".XXXXXX.", "XXXXXXXX", "XXXXXXXX", "XX....XX", "........"],
};

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

let tickMs = 100;
let ready = false;
let info = {};
let benching = false; // the bench drives the state itself; the live loops stand by
let S = fresh();

// Small seeded RNG, so a bench can replay the exact same attack for both brains.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fresh(keep) {
  return {
    tick: 0, cannon: Math.floor(COLS / 2), cooldown: 0,
    creatures: [], bullets: [], events: [], nextId: 1,
    energy: ENERGY_MAX, energyEvery: keep?.energyEvery ?? ENERGY_EVERY, kind: keep?.kind ?? "runner",
    brain: keep?.brain ?? "laya", auto: keep?.auto ?? false, paused: false,
    rng: mulberry32((Math.random() * 2 ** 32) >>> 0),
    target: null, decision: null, ruleId: null,
    stats: keep?.stats ?? { laya: { killed: 0, leaked: 0 }, rule: { killed: 0, leaked: 0 } },
    agree: keep?.agree ?? { same: 0, total: 0 },
    lat: [], stamps: [], errors: 0, flashLeak: 0, hover: null,
    // Every invader the player drops, so the bench can replay the exact same human attack.
    attack: { id: Math.random().toString(36).slice(2, 10), spawns: [] },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const landIn = (c) => (ROWS - 1 - c.row) * KINDS[c.kind].every - (c.age % KINDS[c.kind].every);
const alive = () => S.creatures.filter((c) => c.row < ROWS - 1);

function rulePick(list = alive()) {
  if (!list.length) return null;
  return list.reduce((best, c) =>
    landIn(c) < landIn(best) || (landIn(c) === landIn(best) && Math.abs(c.col - S.cannon) < Math.abs(best.col - S.cannon)) ? c : best);
}

function spawn(col, kind = S.kind, dir = S.rng() < 0.5 ? -1 : 1) {
  const k = KINDS[kind];
  if (S.energy < k.cost || col < 0 || col >= COLS) return false;
  S.energy -= k.cost;
  S.creatures.push({ id: S.nextId++, kind, col, row: 0, hp: k.hp, age: 0, dir });
  return true;
}

// A human drop: spawn it, log it with the tick it happened on, and send the log to the server,
// which keeps it in attacks/ (the bench replays it against both brains).
function humanSpawn(col) {
  const dir = S.rng() < 0.5 ? -1 : 1;
  if (!spawn(col, S.kind, dir)) return;
  S.attack.spawns.push({ tick: S.tick, col, kind: S.kind, dir });
  saveAttack();
}

let saving = false;
async function saveAttack() {
  if (saving || benching || !S.attack.spawns.length) return;
  saving = true;
  try {
    await fetch("/attack", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: S.attack.id, ticks: S.tick, energyEvery: S.energyEvery, spawns: S.attack.spawns }),
    });
  } catch { /* the next drop or the periodic save retries */ }
  saving = false;
}
setInterval(saveAttack, 3000);

function autoAttack() {
  // A simple attacker for tests and footage: spend energy in random bursts.
  // It never looks at the defense, so the same seed replays the same attack for any brain.
  if (S.rng() > 0.35) return;
  const kinds = Object.keys(KINDS).filter((k) => KINDS[k].cost <= S.energy);
  if (!kinds.length) return;
  spawn(Math.floor(S.rng() * COLS), kinds[Math.floor(S.rng() * kinds.length)]);
}

function hitAt(col, row) {
  return S.creatures.find((c) => c.col === col && c.row === row && c.hp > 0);
}

function step() {
  S.tick++;
  S.events = [];
  if (S.tick % S.energyEvery === 0) S.energy = Math.min(ENERGY_MAX, S.energy + 1);
  if (S.auto) autoAttack();

  for (const c of S.creatures) {
    c.age++;
    const k = KINDS[c.kind];
    if (c.age % k.every === 0) {
      c.row++;
      if (k.zig) {
        c.col += c.dir;
        if (c.col < 0 || c.col >= COLS) { c.dir *= -1; c.col += 2 * c.dir; }
      }
    }
  }
  const book = S.stats[S.brain];
  for (const c of S.creatures) {
    if (c.row >= ROWS - 1 && c.hp > 0) {
      c.hp = 0; book.leaked++; S.flashLeak = 6;
      S.events.push({ type: "leak", col: c.col });
    }
  }

  for (const b of S.bullets) {
    for (let i = 0; i <= BULLET_SPEED && !b.done; i++) {
      if (i > 0) b.row--;
      const c = hitAt(b.col, b.row);
      if (c) {
        b.done = true;
        if (--c.hp === 0) { book.killed++; S.events.push({ type: "kill", col: c.col, row: c.row }); }
      } else if (b.row < 0) b.done = true;
    }
  }
  S.bullets = S.bullets.filter((b) => !b.done);
  S.creatures = S.creatures.filter((c) => c.hp > 0);

  if (S.brain === "rule") S.target = rulePick()?.id ?? null;
  const target = S.creatures.find((c) => c.id === S.target);
  if (!target) S.target = null;
  else if (target.col !== S.cannon) S.cannon += Math.sign(target.col - S.cannon);

  if (S.cooldown > 0) S.cooldown--;
  else if (S.creatures.some((c) => c.col === S.cannon)) {
    S.bullets.push({ col: S.cannon, row: ROWS - 1 });
    S.cooldown = COOLDOWN;
  }
  if (S.flashLeak > 0) S.flashLeak--;
}

function describe(c) {
  const dc = c.col - S.cannon;
  const where = dc === 0 ? "right above the cannon" : `${Math.abs(dc)} column${Math.abs(dc) > 1 ? "s" : ""} to the ${dc < 0 ? "left" : "right"}`;
  return `${c.kind}, ${where}, lands in ${landIn(c)} ticks, needs ${c.hp} hit${c.hp > 1 ? "s" : ""}${KINDS[c.kind].zig ? ", zigzags" : ""}`;
}

function snapshot() {
  const list = alive();
  if (!list.length) return null;
  // The most urgent few, then listed left to right, so the order of the options carries no ranking.
  const shown = [...list].sort((a, b) => landIn(a) - landIn(b)).slice(0, MAX_OPTIONS)
    .sort((a, b) => a.col - b.col || a.row - b.row);
  const criteria = {}, ids = {};
  shown.forEach((c, i) => { criteria[LETTERS[i]] = describe(c); ids[LETTERS[i]] = c.id; });
  return {
    ids,
    shown: shown.map((c, i) => ({ letter: LETTERS[i], id: c.id, kind: c.kind, col: c.col })),
    ruleId: rulePick(shown).id,
    state: `Space defense. The cannon is at column ${S.cannon + 1} of ${COLS} and its shot is ${S.cooldown === 0 ? "ready" : "reloading"}. ${list.length} invader${list.length > 1 ? "s" : ""} on screen; the closest one lands in ${Math.min(...list.map(landIn))} ticks.`,
    questions: {
      target: { type: "choice", instructions: "Which invader should the cannon shoot first, so that none reaches the bottom?", criteria },
      pressure: {
        type: "score",
        instructions: "How much pressure is the defense under right now?",
        criteria: [
          "calm: few invaders and none close to landing",
          "busy: several invaders, the cannon has to hurry",
          "overwhelmed: more invaders close to landing than the cannon can stop in time",
        ],
      },
    },
  };
}

async function decide(snap) {
  const res = await fetch("/decide", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: snap.state, questions: snap.questions }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function applyDecision(snap, out) {
  const t = out.answers.target, p = out.answers.pressure;
  const chosen = snap.ids[t.choice];
  if (S.brain === "laya" && S.creatures.some((c) => c.id === chosen)) S.target = chosen;
  S.decision = { snap, probs: t.probabilities, choice: t.choice, confidence: t.confidence, pressure: p.score };
  S.ruleId = snap.ruleId;
  S.agree.total++;
  if (chosen === snap.ruleId) S.agree.same++;
  S.lat.push(out.inference_ms); if (S.lat.length > 30) S.lat.shift();
  S.stamps.push(performance.now()); if (S.stamps.length > 30) S.stamps.shift();
}

async function think() {
  for (;;) {
    if (benching || S.paused || S.brain !== "laya" || !ready) { await sleep(50); continue; }
    const snap = snapshot();
    if (!snap) { S.target = null; S.decision = null; await sleep(tickMs); continue; }
    const started = performance.now();
    try {
      applyDecision(snap, await decide(snap));
    } catch (err) {
      S.errors++;
      console.warn("decide failed", err);
      await sleep(300);
    }
    const elapsed = performance.now() - started;
    if (elapsed < tickMs) await sleep(tickMs - elapsed);
  }
}

async function loop() {
  for (;;) {
    if (!benching && !S.paused && ready) step();
    await sleep(tickMs);
  }
}

// ---- bench ------------------------------------------------------------------------------------

function frameOf() {
  const d = S.brain === "laya" && S.decision;
  return {
    tick: S.tick, cannon: S.cannon, target: S.target,
    creatures: S.creatures.map(({ id, kind, col, row, hp }) => ({ id, kind, col, row, hp })),
    bullets: S.bullets.map(({ col, row }) => ({ col, row })),
    events: S.events.slice(),
    killed: S.stats[S.brain].killed, leaked: S.stats[S.brain].leaked,
    decision: d ? {
      choice: d.choice, confidence: d.confidence, pressure: d.pressure,
      chosenId: d.snap.ids[d.choice], ruleId: d.snap.ruleId,
      letters: Object.fromEntries(d.snap.shown.map((o) => [o.id, o.letter])),
      ms: S.lat[S.lat.length - 1],
    } : null,
  };
}

// The same attack for both brains, one Laya decision before every tick, no wall clock: what
// differs between the two runs is only who picks the target. The attack is either a seeded bot
// or a recorded human one (`attack`, as saved in attacks/), replayed drop by drop on the tick it
// happened, plus `tail` ticks so the invaders still on screen land or die. Every tick is
// recorded, so the two runs can be replayed side by side.
async function bench({ ticks = 600, seed = 1, energyEvery = ENERGY_EVERY, attack = null, tail = 150 } = {}) {
  benching = true;
  // Up to the last human drop plus the tail: the page keeps saving while it stays open, so the
  // log's own tick count can run far past the moment the player stopped.
  if (attack) { ticks = Math.max(...attack.spawns.map((s) => s.tick)) + 1 + tail; energyEvery = attack.energyEvery ?? ENERGY_EVERY; }
  const byTick = new Map();
  for (const s of attack?.spawns ?? []) byTick.set(s.tick, [...(byTick.get(s.tick) ?? []), s]);
  const saved = S, result = { ticks, seed, energyEvery, attacker: attack ? "human" : "bot", drops: attack?.spawns.length, frames: {} };
  try {
    for (const brain of ["rule", "laya"]) {
      S = fresh({ energyEvery });
      Object.assign(S, { brain, auto: !attack, rng: mulberry32(seed), stats: { laya: { killed: 0, leaked: 0 }, rule: { killed: 0, leaked: 0 } }, agree: { same: 0, total: 0 } });
      let spawned = 0, missed = 0;
      const frames = [];
      const t0 = performance.now();
      for (let i = 0; i < ticks; i++) {
        for (const s of byTick.get(i) ?? []) {
          if (spawn(s.col, s.kind, s.dir)) spawned++; else missed++;
        }
        if (brain === "laya") {
          const snap = snapshot();
          if (snap) applyDecision(snap, await decide(snap));
        }
        const before = S.nextId;
        step();
        spawned += S.nextId - before;
        frames.push(frameOf());
      }
      const s = S.stats[brain];
      result[brain] = { spawned, missed, killed: s.killed, leaked: s.leaked, held: s.killed / Math.max(1, s.killed + s.leaked), seconds: (performance.now() - t0) / 1000 };
      if (brain === "laya") {
        result.laya.agreeWithRule = S.agree.same / Math.max(1, S.agree.total);
        result.laya.meanMs = S.lat.reduce((a, b) => a + b, 0) / Math.max(1, S.lat.length);
      }
      result.frames[brain] = frames;
    }
  } finally {
    S = saved;
    benching = false;
  }
  return result;
}

// ---- side-by-side export ----------------------------------------------------------------------

const FONT = "'League Spartan', 'Segoe UI', system-ui, sans-serif";
const MONO = "ui-monospace, 'Cascadia Mono', Consolas, monospace";

function spriteOn(g, name, x0, y0, cell, color) {
  const scale = Math.max(2, Math.floor(cell / 10)), size = 8 * scale;
  const ox = x0 + (cell - size) / 2, oy = y0 + (cell - size) / 2;
  g.fillStyle = color;
  SPRITES[name].forEach((line, y) => { for (let x = 0; x < 8; x++) if (line[x] === "X") g.fillRect(ox + x * scale, oy + y * scale, scale, scale); });
}

function boardOn(g, frames, i, x0, y0, cell, showLetters) {
  const fr = frames[i];
  const w = COLS * cell, h = ROWS * cell;
  g.fillStyle = C.bg; g.fillRect(x0, y0, w, h);
  g.strokeStyle = C.dim; g.lineWidth = 2; g.strokeRect(x0 - 1, y0 - 1, w + 2, h + 2);
  g.fillStyle = C.dot;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) g.fillRect(x0 + c * cell + cell / 2 - 1, y0 + r * cell + cell / 2 - 1, 2, 2);
  // A leak stays on screen for a moment: orange column and floor.
  for (let k = Math.max(0, i - 7); k <= i; k++) {
    for (const e of frames[k].events) if (e.type === "leak") {
      const a = 0.12 + 0.05 * (k - i + 7);
      g.fillStyle = `rgba(255,105,51,${a.toFixed(2)})`; g.fillRect(x0 + e.col * cell, y0, cell, h);
      g.fillStyle = C.orange; g.fillRect(x0, y0 + h - 4, w, 4);
    }
  }
  const letters = (showLetters && fr.decision?.letters) || {};
  for (const c of fr.creatures) {
    spriteOn(g, c.kind, x0 + c.col * cell, y0 + c.row * cell, cell, KINDS[c.kind].color);
    if (c.hp > 1) for (let n = 0; n < c.hp; n++) { g.fillStyle = C.orange; g.fillRect(x0 + c.col * cell + 6 + n * 7, y0 + c.row * cell + cell - 5, 5, 2); }
    if (letters[c.id]) { g.fillStyle = C.sand; g.font = `600 13px ${MONO}`; g.textAlign = "left"; g.fillText(letters[c.id], x0 + c.col * cell + 2, y0 + c.row * cell + 13); }
    if (c.id === fr.target) {
      g.strokeStyle = C.green; g.lineWidth = 2.5;
      const x = x0 + c.col * cell + 2, y = y0 + c.row * cell + 2, s = cell - 4, k = 8;
      g.beginPath();
      for (const [ax, ay, dx, dy] of [[x, y, 1, 1], [x + s, y, -1, 1], [x, y + s, 1, -1], [x + s, y + s, -1, -1]]) {
        g.moveTo(ax + dx * k, ay); g.lineTo(ax, ay); g.lineTo(ax, ay + dy * k);
      }
      g.stroke();
    }
  }
  for (let k = Math.max(0, i - 2); k <= i; k++) {
    for (const e of frames[k].events) if (e.type === "kill") {
      const cx = x0 + e.col * cell + cell / 2, cy = y0 + e.row * cell + cell / 2, r = 6 + 4 * (i - k);
      g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
        g.moveTo(cx + dx * r * 0.4, cy + dy * r * 0.4); g.lineTo(cx + dx * r, cy + dy * r);
      }
      g.stroke();
    }
  }
  g.fillStyle = C.green;
  for (const b of fr.bullets) g.fillRect(x0 + b.col * cell + cell / 2 - 1.5, y0 + b.row * cell + 6, 3, cell - 12);
  spriteOn(g, "cannon", x0 + fr.cannon * cell, y0 + (ROWS - 1) * cell, cell, C.green);
}

function textOn(g, str, x, y, { size = 20, weight = 400, color = C.fg, font = FONT, align = "left" } = {}) {
  g.font = `${weight} ${size}px ${font}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic";
  g.fillText(str, x, y);
  return g.measureText(str).width;
}

function renderSplit(g, result, i, W, H) {
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  const human = result.attacker === "human";
  textOn(g, human ? "Human vs machine. We are the invaders." : "Same attack. Two brains.", 90, 92, { size: 54, weight: 700 });
  textOn(g, human
    ? "One real human attack, replayed drop by drop against both brains. Each brain only picks which invader the cannon chases; aiming and firing are the same code."
    : "A seeded bot drops the invaders, the same ones on both sides. Each brain only picks which one the cannon chases; aiming and firing are the same code.", 90, 132, { size: 21, color: C.sand });
  g.fillStyle = C.orange; g.fillRect(90, 152, 120, 3);

  const cell = 40, top = 262;
  const sides = [
    { x: 90, brain: "laya", name: "Laya", tag: `322M decision model · ${info.hardware || "GPU"} · one forward pass per move`, color: C.green },
    { x: 1010, brain: "rule", name: "One-line rule", tag: "shoot the invader that lands first · no model, no GPU", color: C.fg },
  ];
  for (const s of sides) {
    const frames = result.frames[s.brain], fr = frames[i];
    textOn(g, s.name, s.x, 200, { size: 36, weight: 700, color: s.color });
    textOn(g, s.tag, s.x, 230, { size: 18, color: C.sand });
    boardOn(g, frames, i, s.x, top, cell, s.brain === "laya");
    const bx = s.x + COLS * cell + 34;
    textOn(g, "HELD", bx, top + 30, { size: 18, color: C.muted, font: MONO });
    textOn(g, String(fr.killed), bx, top + 96, { size: 64, weight: 700, color: C.green });
    textOn(g, "LEAKED", bx, top + 150, { size: 18, color: C.muted, font: MONO });
    textOn(g, String(fr.leaked), bx, top + 216, { size: 64, weight: 700, color: fr.leaked ? C.orange : C.muted });
    let recent = 0;
    for (let k = Math.max(0, i - 9); k <= i; k++) recent += frames[k].events.filter((e) => e.type === "leak").length;
    if (recent) textOn(g, `+${recent} got through`, bx, top + 252, { size: 20, weight: 600, color: C.orange });
    if (s.brain === "laya" && fr.decision) {
      const d = fr.decision, agree = d.chosenId === d.ruleId;
      textOn(g, "PICKED", bx, top + 330, { size: 18, color: C.muted, font: MONO });
      textOn(g, `${d.choice}  ·  ${(d.confidence ?? 0).toFixed(2)}`, bx, top + 366, { size: 30, weight: 700, color: C.green, font: MONO });
      textOn(g, "RULE WOULD PICK", bx, top + 412, { size: 18, color: C.muted, font: MONO });
      textOn(g, agree ? "the same" : "another one", bx, top + 446, { size: 26, weight: 600, color: agree ? C.sand : C.orange });
      textOn(g, `${Math.round(d.ms ?? 0)} ms per decision`, bx, top + 500, { size: 18, color: C.sand, font: MONO });
    }
    if (s.brain === "rule") {
      textOn(g, "PICKS", bx, top + 330, { size: 18, color: C.muted, font: MONO });
      textOn(g, "lands first", bx, top + 366, { size: 30, weight: 700, color: C.fg, font: MONO });
      textOn(g, "0 ms · 1 line", bx, top + 500, { size: 18, color: C.sand, font: MONO });
    }
  }
  const clock = (i + 1) / 10;
  textOn(g, `real run, replayed at 1×  ·  ${clock.toFixed(1)} s  ·  github.com/inhabitants/laya-invaders`, 90, H - 42, { size: 18, color: C.muted, font: MONO });
  const fyi = textOn(g, ".fyi", W - 90, H - 42, { size: 24, color: C.sand, align: "right" });
  textOn(g, "Sint", W - 90 - fyi, H - 42, { size: 24, weight: 700, color: C.fg, align: "right" });
}

// Renders ticks [from, to) of the last bench side by side and posts each PNG to the server,
// which only accepts them when it was started with --frames-dir. Frames are named by tick
// (f00000 is the first tick), so an interrupted export resumes with `from` where it stopped.
async function postFrame(i, blob) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`/frame/${String(i).padStart(5, "0")}`, { method: "POST", body: blob });
      if (res.ok) return;
      throw new Error(`frame ${i}: ${res.status}`);
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(500 * attempt);
    }
  }
}

async function exportSplit({ from = 0, to } = {}) {
  const result = window.layaInvaders.last;
  if (!result?.frames?.laya) throw new Error("run a bench first");
  await document.fonts.load("700 54px 'League Spartan'").catch(() => {});
  const W = 1920, H = 1080, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const n = Math.min(result.frames.laya.length, result.frames.rule.length);
  to = Math.min(to ?? n, n);
  for (let i = from; i < to; i++) {
    renderSplit(g, result, i, W, H);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    await postFrame(i, blob);
  }
  return { frames: to - from };
}

// The window of `seconds` where Laya lets the most through compared with the rule.
function busiestWindow(result, seconds = 15) {
  const L = result.frames.laya, R = result.frames.rule, span = seconds * 10;
  let best = { from: 0, gap: -Infinity };
  for (let s = 0; s + span <= L.length; s += 5) {
    const gap = (L[s + span - 1].leaked - (s ? L[s - 1].leaked : 0)) - (R[s + span - 1].leaked - (s ? R[s - 1].leaked : 0));
    if (gap > best.gap) best = { from: s, gap };
  }
  return { from: best.from, to: best.from + span, layaMinusRuleLeaks: best.gap };
}

// ---- live drawing ------------------------------------------------------------------------------

function sprite(name, col, row, color, scale = 3) {
  const rows = SPRITES[name], size = 8 * scale;
  const x0 = col * CELL + (CELL - size) / 2, y0 = row * CELL + (CELL - size) / 2;
  ctx.fillStyle = color;
  rows.forEach((line, y) => { for (let x = 0; x < 8; x++) if (line[x] === "X") ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale); });
}

function draw() {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = C.dot;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) ctx.fillRect(c * CELL + CELL / 2 - 1, r * CELL + CELL / 2 - 1, 2, 2);
  if (S.hover !== null) { ctx.fillStyle = "rgba(196,184,160,.07)"; ctx.fillRect(S.hover * CELL, 0, CELL, CELL * (ROWS - 1)); }
  if (S.flashLeak) { ctx.fillStyle = C.orange; ctx.fillRect(0, CELL * (ROWS - 1) - 3, canvas.width, 3); }

  const letters = {};
  if (S.decision) for (const o of S.decision.snap.shown) letters[o.id] = o.letter;
  for (const c of S.creatures) {
    sprite(c.kind, c.col, c.row, KINDS[c.kind].color);
    if (c.hp > 1) for (let i = 0; i < c.hp; i++) { ctx.fillStyle = C.orange; ctx.fillRect(c.col * CELL + 6 + i * 6, c.row * CELL + CELL - 5, 4, 2); }
    if (letters[c.id] && S.brain === "laya") {
      ctx.fillStyle = C.sand; ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.textAlign = "left";
      ctx.fillText(letters[c.id], c.col * CELL + 2, c.row * CELL + 10);
    }
    if (c.id === S.target) {
      ctx.strokeStyle = C.green; ctx.lineWidth = 2;
      const x = c.col * CELL + 2, y = c.row * CELL + 2, s = CELL - 4, k = 7;
      ctx.beginPath();
      for (const [ax, ay, dx, dy] of [[x, y, 1, 1], [x + s, y, -1, 1], [x, y + s, 1, -1], [x + s, y + s, -1, -1]]) {
        ctx.moveTo(ax + dx * k, ay); ctx.lineTo(ax, ay); ctx.lineTo(ax, ay + dy * k);
      }
      ctx.stroke();
    }
  }
  ctx.fillStyle = C.green;
  for (const b of S.bullets) ctx.fillRect(b.col * CELL + CELL / 2 - 1.5, b.row * CELL + 6, 3, CELL - 12);
  sprite("cannon", S.cannon, ROWS - 1, C.green);
  panel();
  requestAnimationFrame(draw);
}

function pct(a, b) { return b ? Math.round((100 * a) / b) : 0; }

function panel() {
  $("state").textContent = S.paused ? TEXT.paused : TEXT.live;
  $("brain").textContent = S.brain === "laya" ? TEXT.brainLaya : TEXT.brainRule;
  const d = S.decision;
  const opts = $("opts");
  if (S.brain === "laya" && d) {
    const living = new Set(S.creatures.map((c) => c.id));
    opts.innerHTML = d.snap.shown.map((o) => {
      const p = d.probs[o.letter] ?? 0, on = o.letter === d.choice;
      const gone = living.has(o.id) ? "" : " style=\"opacity:.45\"";
      return `<div class="opt${on ? " on" : ""}"${gone}><span>${on ? "›" : " "}</span><span>${o.letter}  ${TEXT.kinds[o.kind]} c${o.col + 1}</span><span class="b"><i style="width:${Math.round(p * 100)}%"></i></span><span>${p.toFixed(2)}</span></div>`;
    }).join("");
  } else opts.innerHTML = `<div class="label">${S.brain === "laya" ? TEXT.none : "-"}</div>`;
  const ruleOpt = d?.snap.shown.find((o) => o.id === d.snap.ruleId);
  $("rule").textContent = ruleOpt ? `${ruleOpt.letter}  ${TEXT.kinds[ruleOpt.kind]} c${ruleOpt.col + 1}${d.snap.ids[d.choice] === d.snap.ruleId ? "  ✓" : "  ✗"}` : "-";
  $("agree").textContent = S.agree.total ? `${pct(S.agree.same, S.agree.total)}%  (${S.agree.same}/${S.agree.total})` : "-";
  const level = d ? Math.max(0, Math.min(2, Math.round(d.pressure))) : 0;
  $("pressure").style.width = `${d ? (d.pressure / 2) * 100 : 0}%`;
  $("pressureTxt").textContent = d ? TEXT.levels[level] : "-";
  const lat = S.lat.length ? S.lat.reduce((a, b) => a + b, 0) / S.lat.length : 0;
  $("lat").textContent = lat ? `${lat.toFixed(1)} ms` : "-";
  const st = S.stamps;
  $("rate").textContent = st.length > 1 ? `${((st.length - 1) / ((st[st.length - 1] - st[0]) / 1000)).toFixed(1)} /s` : "-";
  for (const [id, key] of [["heldLaya", "laya"], ["heldRule", "rule"]]) {
    const s = S.stats[key], n = s.killed + s.leaked;
    $(id).textContent = n ? `${s.killed} ${TEXT.of} ${n}  (${pct(s.killed, n)}%)` : "-";
  }
  $("energy").style.width = `${(S.energy / ENERGY_MAX) * 100}%`;
  const rec = S.attack.spawns.length ? `  · REC ${S.attack.spawns.length} · ${Math.floor(S.tick / 10)} s` : "";
  $("energyTxt").textContent = `${TEXT.energy} ${S.energy}/${ENERGY_MAX}${S.auto ? "  · AUTO" : rec}`;
  for (const b of document.querySelectorAll(".kind")) b.classList.toggle("on", b.dataset.kind === S.kind);
}

// ---- input -----------------------------------------------------------------------------------

function columnAt(event) {
  const r = canvas.getBoundingClientRect();
  return Math.floor(((event.clientX - r.left) / r.width) * COLS);
}
canvas.addEventListener("pointerdown", (e) => { if (!S.paused && !benching) humanSpawn(columnAt(e)); });
canvas.addEventListener("pointermove", (e) => { S.hover = columnAt(e); });
canvas.addEventListener("pointerleave", () => { S.hover = null; });

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (KIND_KEYS[k]) S.kind = KIND_KEYS[k];
  else if (k === "m") { S.brain = S.brain === "laya" ? "rule" : "laya"; S.target = null; S.decision = null; }
  else if (k === "t") S.auto = !S.auto;
  else if (k === " ") { S.paused = !S.paused; e.preventDefault(); }
  else if (k === "r") S = fresh(S);
  else if (k === "+" || k === "=") tickMs = Math.max(40, tickMs - 20);
  else if (k === "-") tickMs = Math.min(300, tickMs + 20);
});

function setup() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = TEXT[el.dataset.t];
  $("keys").textContent = TEXT.keys;
  $("kinds").innerHTML = Object.entries(KINDS).map(([name, k], i) =>
    `<button class="kind" data-kind="${name}" style="color:${k.color}">${i + 1} ${TEXT.kinds[name]} · ${k.cost}</button>`).join("");
  for (const b of document.querySelectorAll(".kind")) b.addEventListener("click", () => { S.kind = b.dataset.kind; });
  $("overlay").textContent = TEXT.loading;
}

async function waitForModel() {
  for (;;) {
    try {
      info = await (await fetch("/info")).json();
      if (info.ready) {
        $("device").textContent = `${info.hardware} · ${info.engine} ${info.precision} · local`;
        $("overlay").hidden = true;
        ready = true;
        return;
      }
      if (info.error) { $("overlay").textContent = `${TEXT.failed} ${info.error}`; return; }
    } catch { /* server still starting */ }
    await sleep(500);
  }
}

// Console hooks: layaInvaders.run({ ticks: 600, seed: 1, energyEvery: 3 }) benches both brains on the
// same attack; layaInvaders.exportRun(layaInvaders.window(15)) writes side-by-side frames.
window.layaInvaders = {
  get state() { return S; }, spawn, bench,
  set auto(v) { S.auto = v; }, set brain(v) { S.brain = v; },
  run(opts) { this.last = "running"; bench(opts).then((r) => { this.last = r; }, (e) => { this.last = String(e); }); return "started"; },
  summary() { const r = this.last; return r?.frames ? { ...r, frames: undefined } : r; },
  // Replays the latest saved human attack (attacks/latest.json) against both brains.
  async runHuman(opts = {}) {
    const attack = await (await fetch("/attack")).json();
    if (!attack.spawns?.length) return "no human attack saved yet";
    return this.run({ ...opts, attack });
  },
  window(seconds) { return busiestWindow(this.last, seconds); },
  exportRun(range) { this.exported = "running"; exportSplit(range).then((r) => { this.exported = r; }, (e) => { this.exported = String(e); }); return "started"; },
};

setup();
draw();
waitForModel();
loop();
think();
