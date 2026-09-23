#!/usr/bin/env python3
"""Send one image plus text to llama-server.

/v1/decision takes text-only contexts ("contexts" must be an array of strings), so an image cannot be
a decision context directly. This does both halves of the job:

  1. /v1/chat/completions with the image as an image_url content part -> the vision model describes it.
  2. /v1/decision with that description as the context -> the schema is answered in one batched pass.

Requires ffmpeg on PATH for formats stb_image cannot decode (avif, heic, webp, tiff).

    python scripts/image-context.py C:\\Users\\91728\\Downloads\\73760.avif "What is in this image?"
"""

import argparse
import base64
import json
import mimetypes
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

# stb_image (llama.cpp's image decoder) handles jpg/png/bmp/gif/tga/pnm; everything else is converted.
CONVERT = {".avif", ".heic", ".heif", ".webp", ".tiff", ".tif", ".jxl"}

CATEGORIES = ["animal", "object", "person"]


def post(url: str, body: dict, timeout: int = 600) -> dict:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:            # the server answers errors as JSON too
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        sys.exit(f"HTTP {e.code} from {url}: {detail}")


def as_png(path: pathlib.Path) -> pathlib.Path:
    if path.suffix.lower() not in CONVERT:
        return path
    out = pathlib.Path(tempfile.gettempdir()) / (path.stem + ".png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), str(out)], check=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image", type=pathlib.Path)
    ap.add_argument("text", nargs="?", default="What is in this image? Answer in one short sentence.")
    ap.add_argument("--server", default="http://localhost:8096")
    ap.add_argument("--model", default="gemma-4-12b")
    ap.add_argument("--decide", action="store_true", help="also answer the schema through /v1/decision")
    ap.add_argument("--choices", default=",".join(CATEGORIES))
    args = ap.parse_args()

    png = as_png(args.image)
    if png is not args.image:
        print(f"-- converted {args.image.name} -> {png} (llama.cpp cannot decode {args.image.suffix[1:]})")
    data = base64.b64encode(png.read_bytes()).decode()

    # 1. the only endpoint that takes media: image_url + text as content parts
    chat = post(f"{args.server}/v1/chat/completions", {
        "model": args.model,
        "temperature": 0,
        "max_tokens": 256,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": args.text},
            {"type": "image_url", "image_url": {"url": f"data:{mimetypes.guess_type(png.name)[0] or 'image/png'};base64,{data}"}},
        ]}],
    })
    description = (chat["choices"][0]["message"].get("content") or "").strip()
    print(f"\n== /v1/chat/completions ==\n{description}")
    print(f"   {chat['usage']['prompt_tokens']} prompt tokens | {chat['timings']['prompt_ms']:.0f} ms prefill")

    if not args.decide:
        return

    # 2. the description is what /v1/decision can actually consume
    dec = post(f"{args.server}/v1/decision", {
        "model": args.model,
        "instructions": "Answer each question about the user request from its state.",
        "contexts": [description],
        "schema": {"category": {"type": "enum", "choices": args.choices.split(","), "description": "What type of support image is this?"}},
        "mode": "auto",
        "cache_prompt": True,
    })
    print(f"\n== /v1/decision ==\n{json.dumps(dec['results'][0]['decision'], indent=2)}")
    print(f"   {dec['timings']['total_ms']:.0f} ms | {dec['usage']['context_tokens']} context tokens")


if __name__ == "__main__":
    main()
