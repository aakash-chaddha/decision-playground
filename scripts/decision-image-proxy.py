#!/usr/bin/env python3
"""Make /v1/decision accept images.

The decision engine is text-only: "contexts" is validated as an array of strings before anything
reaches the model, so an image_url part is rejected with HTTP 400. This shim sits in front of
llama-server and gives you the endpoint you actually want:

    POST /v1/decision  { contexts: [ {type: text}, {type: image_url} ], schema: {...} }

For every context that carries media it asks the vision model one question per schema field, turns
the answer into a text observation, and then calls the real /v1/decision with those observations -
so all the answers, probabilities and timings still come from the decision engine. Contexts that are
already plain strings pass through untouched, and everything else (chat completions, models, health)
is proxied as-is, so this can be used as the server URL in the playground.

    python scripts/decision-image-proxy.py --upstream http://localhost:8096 --port 8097
"""

import argparse
import http.client
import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MEDIA_PARTS = ('image_url', 'input_audio', 'input_video')


def resolve(url: str) -> str:
    """Pin 'localhost' to its IPv4 address once. http.client tries getaddrinfo results in order, so a
    server bound to 0.0.0.0 (IPv4 only) costs a failed IPv6 connect on every single hop otherwise."""
    u = urlparse(url)
    if u.hostname != 'localhost':
        return url
    try:
        info = socket.getaddrinfo('localhost', u.port or 80, socket.AF_INET, socket.SOCK_STREAM)[0]
    except OSError:
        return url
    return f'{u.scheme}://{info[4][0]}:{u.port or 80}'


def observation_prompt(schema: dict, text: str) -> str:
    """One question per schema field, built from the field's own description and choices."""
    lines = []
    for name, field in schema.items():
        if not isinstance(field, dict):
            continue
        desc = field.get('description') or name
        choices = field.get('enum') or field.get('choices')
        if choices:
            desc += f" (one of: {', '.join(str(c) for c in choices)})"
        lines.append(f'- {name}: {desc}')
    ask = ('Describe the image by answering each line with a short factual phrase. '
           'State every number explicitly.\n' + '\n'.join(lines))
    return f'{text}\n\n{ask}' if text.strip() else ask


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    upstream = 'http://localhost:8096'

    def log_message(self, fmt, *args):
        print(f'{self.command} {self.path} - {fmt % args}', flush=True)

    # --- upstream helpers ---

    def _connect(self):
        u = urlparse(self.upstream)
        return http.client.HTTPConnection(u.hostname, u.port or 80, timeout=600)

    def _post(self, path: str, body: dict) -> dict:
        conn = self._connect()
        conn.request('POST', path, json.dumps(body), {'Content-Type': 'application/json'})
        res = conn.getresponse()
        data = json.loads(res.read() or b'{}')
        conn.close()
        return data

    # --- the shim ---

    def observe(self, context, schema: dict, model: str, instructions: str) -> tuple[str, str]:
        """context parts -> (text observation, note)"""
        texts, media = [], []
        for part in context:
            if part.get('type') == 'text':
                texts.append(part.get('text', ''))
            elif part.get('type') in MEDIA_PARTS:
                media.append(part)
        if not media:
            return '\n'.join(texts).strip(), 'text'

        msg = self._post('/v1/chat/completions', {
            'model': model,
            'stream': False,
            'max_tokens': 256,
            'temperature': 0,
            'chat_template_kwargs': {'enable_thinking': False},
            'messages': [
                {'role': 'system', 'content': 'You describe images for a downstream classifier. Answer only what is asked, in plain sentences.'},
                {'role': 'user', 'content': [{'type': 'text', 'text': observation_prompt(schema, '\n'.join(texts))}, *media]},
            ],
        })
        if 'error' in msg:
            raise RuntimeError(msg['error'].get('message', 'vision request failed'))
        return (msg['choices'][0]['message'].get('content') or '').strip(), 'image'

    def do_POST(self):
        if self.path.rstrip('/') != '/v1/decision':
            return self.passthrough()

        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        contexts = body.get('contexts') or []
        schema = body.get('schema') or {}
        model = body.get('model', '')
        instructions = body.get('instructions', '')

        # only rewrite the contexts that actually carry media
        rewritten, notes = [], []
        try:
            for context in contexts:
                if isinstance(context, list):
                    text, note = self.observe(context, schema, model, instructions)
                    rewritten.append(text)
                    notes.append(note)
                else:
                    rewritten.append(context)
                    notes.append('text')
        except Exception as e:  # noqa: BLE001 - reported to the caller as an API error
            return self.send_json(502, {'error': {'code': 502, 'message': f'vision step failed: {e}',
                                                  'type': 'proxy_error'}})

        out = self._post('/v1/decision', body | {'contexts': rewritten})
        if 'error' not in out:
            for item, note, text in zip(out.get('results', []), notes, rewritten):
                if note == 'image':
                    item['observation'] = text          # what the decision actually ran on
        self.send_json(200, out)

    def passthrough(self):
        length = int(self.headers.get('Content-Length') or 0)
        payload = self.rfile.read(length) if length else None
        conn = self._connect()
        conn.request(self.command, self.path, payload, {'Content-Type': 'application/json'})
        res = conn.getresponse()
        self.send_response(res.status)
        for k, v in res.getheaders():
            if k.lower() not in ('transfer-encoding', 'content-length', 'connection'):
                self.send_header(k, v)
        self.send_header('Connection', 'close')
        self.end_headers()
        while chunk := res.read(8192):                  # relay as it arrives, so SSE still streams
            self.wfile.write(chunk)
            self.wfile.flush()
        conn.close()

    do_GET = do_POST

    def send_json(self, code: int, payload: dict):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upstream', default='http://localhost:8096')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8097)
    args = ap.parse_args()
    Handler.upstream = resolve(args.upstream)
    print(f'/v1/decision with images on http://{args.host}:{args.port}  ->  {Handler.upstream}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
