# Decision Playground

A browser-only UI for llama-server's `/v1/decision` endpoint (the `parallel-decision` llama.cpp branch).
There is no backend: the page talks to llama-server directly, and its only setting is the server URL.

- **Playground** — write instructions, a finite schema (form or JSON) and a context, then compare one
  `/v1/decision` pass with a streamed, grammar-constrained `/v1/chat/completions` run on the same model:
  per-field answers and probabilities, server and round-trip timings, and the exact request payloads.
- **Game** — a small top-down arena where agents pick their controls with `/v1/decision` several times
  a second (moving target, or a duel where both agents are models).

## Run

```bash
npm install
npm run dev
```

Set the llama-server URL in the header (stored in the browser). To bake a default into a build, set
`VITE_DEFAULT_SERVER` (for example in `.env.local`); otherwise it defaults to `http://localhost:8080`.

The server needs `--decision-seqs N` (or `decision-seqs = N` in a router preset). In router mode the model
list and "loaded" markers come from `/v1/models`, and requests pick the model with the `model` field.

```bash
npm run build   # static files in dist/, servable by any web server
```
