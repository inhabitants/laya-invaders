# laya-invaders

**English** · [Português](README.pt-BR.md) · [Site](https://www.sapiensinteticos.com/laya-invaders)

Human vs machine, on your own graphics card. Space Invaders, flipped: your PC is Earth, you are the invader, and [Laya](https://github.com/NandhaKishorM/laya), a small decision model by Convai Innovations, defends it by picking which invader the cannon chases.

![Live: a human drops invaders column by column while Laya's cannon picks targets on an RTX 3070](docs/live.gif)

*Live on an RTX 3070. The panel shows the options Laya gets, its probabilities, and when it disagrees with the rule.*

Inspired by the Snake demo that [mizorewww/laya-mlx](https://github.com/mizorewww/laya-mlx) built for Laya on Apple Silicon, which we ported to NVIDIA and CPU in [laya-snake-cuda](https://github.com/inhabitants/laya-snake-cuda). That demo shows how fast a typed decision is. This one asks whether the decision is any good.

## Why this test

Laya is a 322M model that doesn't write text: it answers typed questions with probabilities in one forward pass, with zero output tokens. It is the open take on the "fast thinking" decision models that products like Jev promise. In the Snake demo a planner writes "Best" next to one of the options, so the model never has to judge. Here it does: which threat first.

## What keeps it fair

- **Facts, not advice.** Each invader is offered as plain facts: kind, how far from the cannon, ticks until it lands, hits it takes. For example: `tank, 3 columns to the left, lands in 42 ticks, needs 3 hits`. No option is marked as the best one.
- **Order says nothing.** When more than 5 invaders are on screen, the 5 closest to landing are offered, listed left to right.
- **Same hands.** Aiming and firing are plain code, identical for both sides. The only thing that differs is who picks the target.
- **Same attack.** Every invader you drop is recorded with the tick it happened on. The bench replays your exact attack against Laya and against the baseline, a one-line rule: shoot the invader that lands first.

Laya also answers a second question in the same pass (pressure: calm, busy or overwhelmed). The panel shows it; the cannon doesn't use it.

## Results

**One human attack, 24 invaders**, replayed drop by drop against both brains:

| Brain | Held | Got through |
|---|---|---|
| One-line rule (lands first) | 23 | 1 |
| Laya | 22 | 2 |

They picked the same target 64% of the time, at about 57 ms per Laya decision. Laya's 22 of 24 in the replay matches what the live panel showed while the attack was happening.

![Side by side: the same human attack against Laya and against the one-line rule](docs/invaders.gif)

**A seeded bot pushing harder**, 600 ticks, same attack for both:

| Attack | Rule | Laya | Picks in common |
|---|---|---|---|
| Normal | 52 of 52 | 50 of 52 | 86% |
| Double energy for the attacker | 87 of 89 | 71 of 87 | 35% |

The rule wins, and the gap grows with the pressure. The runs are deterministic: the same attack gives the same numbers every time.

Fast doesn't mean it knows how to weigh: a decision model only proves itself with a dumb rule next to it.

## Run it

Python 3.10 or newer.

```bash
git clone https://github.com/inhabitants/laya-invaders
cd laya-invaders
python -m venv .venv
```

Activate it (`.venv\Scripts\activate` on Windows, `source .venv/bin/activate` on Linux), then:

```bash
# NVIDIA GPU: install a CUDA build of PyTorch first (RTX 50 series needs cu128 or newer)
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements.txt
python server.py --download
python server.py
```

`--download` fetches the multilingual checkpoint (~0.65 GB) into `./models/laya`, pinned to the revision these numbers came from. Then open http://127.0.0.1:8765. The server listens on your machine only. No GPU: skip the torch line and add `--device cpu` (around 300 ms per decision; press `-` to slow the game down).

| Key | |
|---|---|
| **Click** a column | Drop an invader there |
| **1 2 3** | Pick the kind: runner, zigzag, tank |
| **M** | Swap the brain between Laya and the rule |
| **T** | Turn the bot attacker on or off (bot drops are not recorded) |
| **Space** / **R** / **+ -** | Pause / new recording / speed |

Portuguese on screen: http://127.0.0.1:8765/?lang=pt

## Replay your own attack

While you play, the panel shows `REC` and every drop is saved to `attacks/` (one file per session, plus `latest.json`). When you're done, in the browser console:

```js
layaInvaders.runHuman()   // your latest attack against both brains
layaInvaders.summary()
```

For the bot bench: `layaInvaders.run({ ticks: 600, seed: 1, energyEvery: 3 })` (`6` is the normal attack, `3` the double one). To export the side-by-side replay, start the server with `--frames-dir frames`, run a bench, then `layaInvaders.exportRun({ from: 0, to: 600 })` and turn the frames into video:

```bash
ffmpeg -framerate 10 -i frames/f%05d.png -r 30 -c:v libx264 -crf 20 -pix_fmt yuv420p replay.mp4
```

## Status

Published as is, not maintained. Tested on Windows 11, Python 3.11, PyTorch 2.11 (CUDA 13), `laya` 0.3.5, RTX 3070. The page loads the League Spartan font from Google Fonts.

## License

MIT for this code, see [LICENSE](LICENSE). Laya and its weights are Apache-2.0 by Convai Innovations; the weights are downloaded separately and are not included here.

---

Made at [Sapiens Sintéticos](https://www.sapiensinteticos.com).
