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

`/v1/decision` takes `contexts`, a list of 1-256 context strings, and returns `results` in the same order; all
contexts share the schema, the instructions and the cached prompt prefix. In the playground, separate several
contexts with a line of `---`; the game sends both duel agents in one request.

The server needs `--decision-seqs N` (or `decision-seqs = N` in a router preset). In router mode the model
list and "loaded" markers come from `/v1/models`, and requests pick the model with the `model` field.

When the selected model reports multimodal input — `modalities` in `GET /props` for a single-model server, or
`architecture.input_modalities` per model in router mode — the Playground shows an **Attach** control under the
context. Images, audio and video become OpenAI content parts (`image_url`, `input_audio`, `input_video`); PDFs
are rasterised to page images in the browser, because llama.cpp has no PDF decoder. Text files are inlined as a
text part.

Both runs take the attachments. `/v1/chat/completions` gets them as content parts of the user message.
`/v1/decision` takes a context as a string or as an array of parts — any number of `text`, `image_url` and
`input_audio` parts per context. Text and audio go with every context; the images go with every context too,
except when the media parts pair up with the contexts one to one (N images, or a PDF's pages, and N contexts
separated by `---`), which sends one per context. Video stays on the chat side: mtmd has no video chunk type,
so send frames as images. The decision card reports the `media_tokens` the media occupied.

```bash
npm run build   # static files in dist/, servable by any web server
```
