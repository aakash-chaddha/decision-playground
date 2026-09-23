#!/usr/bin/env python3
"""Send one image to /v1/decision and /v1/chat/completions and compare the two.

Both requests carry the same instructions and the same image (no caption), and both answer the same
schema:

    hands: integer 1-5      legs: integer 1-5      type: person | animal | object

/v1/decision scores the fields in one pass and returns a probability per field; /v1/chat/completions
generates the JSON under a json_schema grammar (thinking off, temperature 0). The script prints the
answer, the usage and the timings from each, and exits 1 if the two answers disagree.

Requires a running llama-server with an mmproj (vision), e.g.

    llama-server -m model.gguf --mmproj mmproj.gguf --decision-seqs 12 --jinja -ngl 99 \\
        --ubatch-size 2048 --port 8080

    python scripts/quickstart.py C:\\Users\\me\\Downloads\\73760.png --server http://127.0.0.1:8080
"""

import argparse
import base64
import json
import mimetypes
import pathlib
import sys
import time
import urllib.error
import urllib.request

SCHEMA = {
    "hands": {"type": "integer", "minimum": 1, "maximum": 5, "description": "How many hands or arms are visible?"},
    "legs":  {"type": "integer", "minimum": 1, "maximum": 5, "description": "How many legs are visible?"},
    "type":  {"type": "enum", "choices": ["person", "animal", "object"], "description": "What is the main subject?"},
}

JSONSCHEMA = {
    "type": "object",
    "properties": {
        "hands": {"type": "integer", "minimum": 1, "maximum": 5},
        "legs":  {"type": "integer", "minimum": 1, "maximum": 5},
        "type":  {"type": "string", "enum": ["person", "animal", "object"]},
    },
    "required": ["hands", "legs", "type"],
    "additionalProperties": False,
}


def get(url: str, timeout: float):
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.load(res)


def post(url: str, body: dict, timeout: float) -> tuple[dict, float]:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res), time.time() - t0
    except urllib.error.HTTPError as e:  # the server answers errors as JSON too
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise SystemExit(f"HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"cannot reach {url}: {e.reason}") from None


def pick_model(server: str, model: str | None, timeout: float) -> str:
    if model:
        return model
    try:
        models = get(f"{server}/v1/models", timeout).get("data", [])
    except Exception:
        models = []
    if not models:
        raise SystemExit("no model given and /v1/models is empty; pass --model")
    if len(models) > 1:
        print("models:", ", ".join(m["id"] for m in models), file=sys.stderr)
    return models[0]["id"]


def data_url(path: pathlib.Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def decision_body(model: str, instructions: str, image: str, text: str) -> dict:
    parts = [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": image}}]
    return {"model": model, "instructions": instructions, "schema": SCHEMA, "contexts": [parts]}


def chat_body(model: str, instructions: str, image: str, text: str, max_tokens: int) -> dict:
    # the same field catalogue the decision engine puts in its system message
    catalog = "\n".join(f'"{name}": {spec["description"]}' for name, spec in SCHEMA.items())
    system = ("Select the requested field value from its allowed values, based on the context. "
              "Respond with the JSON value only.\n\nFields:\n" + catalog + "\n" + instructions)
    parts = [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": image}}]
    return {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": parts}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "scene", "schema": JSONSCHEMA, "strict": True}},
        "chat_template_kwargs": {"enable_thinking": False},
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }


def run_decision(server: str, body: dict, timeout: float) -> dict:
    out, wall = post(f"{server}/v1/decision", body, timeout)
    r = out["results"][0]
    return {"wall": wall, "answer": r["decision"], "fields": r["fields"],
            "usage": out["usage"], "timings": out["timings"]}


def run_chat(server: str, body: dict, timeout: float) -> dict:
    out, wall = post(f"{server}/v1/chat/completions", body, timeout)
    msg = out["choices"][0]["message"]
    raw = (msg.get("content") or "").strip()
    if not raw and msg.get("reasoning_content"):
        raise SystemExit("chat returned only reasoning; pass --thinking to keep it, or check the chat template")
    try:
        answer = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"chat did not return JSON ({e}): {raw!r}") from None
    return {"wall": wall, "answer": answer, "raw": raw, "finish": out["choices"][0].get("finish_reason"),
            "usage": out["usage"], "timings": out["timings"]}


def show_decision(title: str, res: dict) -> None:
    print(f"\n{title}")
    print("-" * 72)
    print(f"  answer   {json.dumps(res['answer'])}")
    print("  fields   " + "   ".join(f"{n}={f['value']} p={f['probability']:.4f}"
                                     for n, f in res["fields"].items()))
    u = res["usage"]
    print(f"  usage    prompt_tokens={u['prompt_tokens']} cached_tokens={u['cached_tokens']} "
          f"context_tokens={u['context_tokens']} media_tokens={u.get('media_tokens', 0)} "
          f"scored_rows={u['scored_rows']}")
    t = res["timings"]
    print(f"  timings  prefill={t['prefill_ms']:.1f} ms  scoring={t['scoring_ms']:.1f} ms  "
          f"total={t['total_ms']:.1f} ms  rounds={t['rounds']}   wall={res['wall']:.3f} s")


def show_chat(title: str, res: dict) -> None:
    print(f"\n{title}")
    print("-" * 72)
    print(f"  answer   {json.dumps(res['answer'])}")
    print("  raw      " + " ".join(res["raw"].split()))
    u, t = res["usage"], res["timings"]
    print(f"  usage    prompt_tokens={u['prompt_tokens']} cached_tokens="
          f"{u['prompt_tokens_details']['cached_tokens']} completion_tokens={u['completion_tokens']} "
          f"({t['predicted_per_second']:.1f} tok/s)")
    print(f"  timings  prompt={t['prompt_ms']:.1f} ms  predicted={t['predicted_ms']:.1f} ms  "
          f"finish={res['finish']}   wall={res['wall']:.3f} s")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="path to the image to send (png, jpg, ...what stb_image can read)")
    ap.add_argument("--server", default="http://127.0.0.1:8080", help="llama-server base URL (default: %(default)s)")
    ap.add_argument("--model", help="model id; default: the first entry of /v1/models")
    ap.add_argument("--instructions", default="Answer each question about the image. The pixels are the evidence.",
                    help="instructions shared by both requests")
    ap.add_argument("--text", default="", help="optional text part sent next to the image")
    ap.add_argument("--max-tokens", type=int, default=128, help="chat completion budget (default: %(default)s)")
    ap.add_argument("--runs", type=int, default=2, help="how many times to call each endpoint (default: %(default)s)")
    ap.add_argument("--timeout", type=float, default=600, help="request timeout in seconds (default: %(default)s)")
    args = ap.parse_args()

    server = args.server.rstrip("/")
    path = pathlib.Path(args.image)
    if not path.is_file():
        raise SystemExit(f"no such file: {path}")
    model = pick_model(server, args.model, args.timeout)
    image = data_url(path)

    print(f"server   {server}")
    print(f"model    {model}")
    print(f"image    {path}  ({path.stat().st_size} bytes)")

    dbody = decision_body(model, args.instructions, image, args.text)
    cbody = chat_body(model, args.instructions, image, args.text, args.max_tokens)

    answers = []
    for run in range(1, args.runs + 1):
        res = run_decision(server, dbody, args.timeout)
        show_decision(f"/v1/decision   run {run}/{args.runs}", res)
        answers.append(("decision", res["answer"]))
    for run in range(1, args.runs + 1):
        res = run_chat(server, cbody, args.timeout)
        show_chat(f"/v1/chat/completions   run {run}/{args.runs}", res)
        answers.append(("chat", res["answer"]))

    ref_name, ref = answers[0]
    same = all(a == ref for _, a in answers)
    print("\nmatch: " + ("yes" if same else "NO"))
    if not same:
        for name, a in answers:
            print(f"  {name:8s} {a}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
