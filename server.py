"""Laya over HTTP for the browser game, local only (127.0.0.1).

GET  /             the game (index.html, game.js)
GET  /info         {"ready": bool, "hardware", "engine", "precision", "model"} while the model loads
POST /decide       {"state": str|dict, "questions": {...}} -> Laya's answers + inference_ms
POST /frame/NNNNN  a PNG of the side-by-side replay, saved as fNNNNN.png; only exists when the
                   server was started with --frames-dir (turn the frames into video with ffmpeg)

The server knows nothing about the game: the page builds the state and the typed questions,
so the same page can later swap this endpoint for Laya running inside the browser.

First time:  python server.py --download   (the checkpoint, ~0.65 GB, into ./models/laya)
Then:        python server.py              and open http://127.0.0.1:8765
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/game.js": ("game.js", "text/javascript; charset=utf-8"),
}
MAX_BODY = 64 * 1024
MAX_FRAME = 8 * 1024 * 1024
MAX_QUESTIONS = 6
QTYPES = ("choice", "score", "noul")

RUNTIME = {"agent": None, "info": {"ready": False}, "lock": threading.Lock(), "frames": None}

HF_REPO = "convaiinnovations/laya"
HF_REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"  # the revision these numbers were measured on
CHECKPOINT_FILES = ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")


def download(model_dir, subfolder):
    """Fetch one Laya checkpoint into a plain folder (the HF cache needs symlinks, which Windows denies without admin)."""
    from huggingface_hub import snapshot_download

    prefix = f"{subfolder}/" if subfolder else ""
    print(f"Downloading {HF_REPO} ({subfolder or 'root'}) into {model_dir} ...", file=sys.stderr, flush=True)
    snapshot_download(
        HF_REPO,
        revision=HF_REVISION,
        local_dir=str(model_dir),
        allow_patterns=[prefix + name for name in CHECKPOINT_FILES],
    )
    print("Done. Now run: python server.py", file=sys.stderr, flush=True)


def load(model_dir, subfolder, device):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        import laya
        import torch

        agent = laya.load(model_dir, device=device, subfolder=subfolder or None)
        agent.predict("Warm-up.", {"q": {"type": "noul", "instructions": "Is this a warm-up?"}})
        dev = agent.device
        RUNTIME["agent"] = agent
        RUNTIME["info"] = {
            "ready": True,
            "hardware": (
                torch.cuda.get_device_name(dev).removeprefix("NVIDIA ").removeprefix("GeForce ")
                if dev.type == "cuda" else "CPU"
            ),
            "engine": dev.type.upper(),
            "precision": "FP32" if dev.type == "cpu" else ("BF16" if "bfloat16" in str(agent.dtype) else "FP16"),
            "model": f"convaiinnovations/laya/{subfolder}" if subfolder else "convaiinnovations/laya",
        }
        print(f"Laya ready on {RUNTIME['info']['hardware']}", file=sys.stderr, flush=True)
    except Exception as error:  # surfaced to the page through /info
        RUNTIME["info"] = {"ready": False, "error": repr(error)}
        print(f"Laya failed to load: {error!r}", file=sys.stderr, flush=True)


def valid_questions(questions):
    if not isinstance(questions, dict) or not 0 < len(questions) <= MAX_QUESTIONS:
        return False
    for q in questions.values():
        if not isinstance(q, dict) or q.get("type") not in QTYPES or not isinstance(q.get("instructions"), str):
            return False
        crit = q.get("criteria")
        if q["type"] in ("choice", "score") and not isinstance(crit, (dict, list)):
            return False
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/info":
            return self.send_json(200, RUNTIME["info"])
        if path in STATIC:
            name, kind = STATIC[path]
            body = (HERE / name).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        frame = re.fullmatch(r"/frame/(\d{5})", self.path)
        if frame and RUNTIME["frames"] is not None:
            return self.save_frame(frame.group(1))
        if self.path != "/decide":
            return self.send_json(404, {"error": "not found"})
        agent = RUNTIME["agent"]
        if agent is None:
            return self.send_json(503, {"error": "model loading", "info": RUNTIME["info"]})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self.send_json(413, {"error": "body too large"})
        try:
            payload = json.loads(self.rfile.read(length))
            state, questions = payload["state"], payload["questions"]
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": "expected {state, questions}"})
        if not isinstance(state, (str, dict, list)) or len(json.dumps(state)) > 8000 or not valid_questions(questions):
            return self.send_json(400, {"error": "invalid state or questions"})
        try:
            with RUNTIME["lock"]:
                started = time.perf_counter()
                output = agent.predict(state, questions)
                output["inference_ms"] = (time.perf_counter() - started) * 1000
        except Exception as error:
            return self.send_json(422, {"error": str(error)})
        self.send_json(200, output)

    def save_frame(self, number):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_FRAME:
            return self.send_json(413, {"error": "frame too large"})
        data = self.rfile.read(length)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return self.send_json(400, {"error": "expected a PNG"})
        (RUNTIME["frames"] / f"f{number}.png").write_bytes(data)
        self.send_json(200, {"saved": number})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=str(HERE / "models" / "laya"), help="Local checkpoint folder (default: ./models/laya)")
    parser.add_argument("--subfolder", default="multilingual", help="multilingual (default), typed-decisions, or '' for the English root")
    parser.add_argument("--device", help="cuda, cuda:1, cpu... (default: CUDA when available)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--download", action="store_true", help="Download the checkpoint into --model and exit")
    parser.add_argument("--frames-dir", type=Path, help="Accept side-by-side replay frames (POST /frame/NNNNN) into this folder")
    args = parser.parse_args(argv)
    if args.download:
        return download(args.model, args.subfolder)
    if not (Path(args.model) / (args.subfolder or "") / "model.safetensors").is_file():
        print(f"No Laya checkpoint in {Path(args.model) / (args.subfolder or '')}. Run first: python server.py --download", file=sys.stderr)
        return 1
    if args.frames_dir:
        args.frames_dir.mkdir(parents=True, exist_ok=True)
        RUNTIME["frames"] = args.frames_dir
    threading.Thread(target=load, args=(args.model, args.subfolder, args.device), daemon=True).start()
    # Threaded: browsers keep idle preconnections open, which would block a one-at-a-time server.
    # The model itself stays serialized by RUNTIME["lock"].
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Laya Invaders on http://127.0.0.1:{args.port} (model loading...)", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
