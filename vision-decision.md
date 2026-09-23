# Vision on `/v1/decision`

How `POST /v1/decision` learned to take images, so schema fields are scored **directly conditioned on
the pixels** — one batched pass, no intermediate caption.

This is the retrospective of `plan.md`. The code lives in the fork
(`F:/lab/jev/llama.cpp`, branch `parallel-decision-media`), not in this repo.

| commit | what |
|---|---|
| `cbb875cd6` `parallel-decision : segmented contexts and a media decode callback` | engine: segments + callback, branch positions, `render_prompt` markers |
| `89f5c5d27` `server : image contexts for /v1/decision` | server: parse, tokenise, encode, decode, guard, usage, README |

Branch base: `parallel-decision` (`14d04e755`).

---

## 1. The endpoint before and after

Before, `contexts` was an array of non-empty strings. `image_url` was rejected with a 400 before
anything reached the model, so a client that wanted image-conditioned decisions had to caption the
image first and feed the caption as text (`scripts/decision-image-proxy.py`: two hops, ~0.72 s, and
the probabilities are conditioned on generated prose, not on the pixels).

After, a context may also be an array of OpenAI-style content parts:

```jsonc
POST /v1/decision
{
  "model": "gemma-4-12b",
  "instructions": "Answer each question about the image. The pixels are the evidence.",
  "schema": {
    "hands": {"type": "integer", "minimum": 1, "maximum": 5, "description": "How many hands or arms are visible?"},
    "legs":  {"type": "integer", "minimum": 1, "maximum": 5, "description": "How many legs are visible?"},
    "type":  {"type": "enum", "choices": ["person", "animal", "object"], "description": "What is the main subject?"}
  },
  "contexts": [[
    {"type": "text", "text": ""},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
  ]]
}
```

Response shape is unchanged (`results[].decision`, `results[].fields[].probability`, `usage`,
`timings`), with `usage.media_tokens` added per result and per request:

```json
{
  "results": [{
    "decision": {"hands": 2, "legs": 2, "type": "animal"},
    "fields": {
      "hands": {"value": 2,      "probability": 0.9998, "scored_nodes": 1, "tree": true},
      "legs":  {"value": 2,      "probability": 1.0,    "scored_nodes": 1, "tree": true},
      "type":  {"value": "animal","probability": 1.0,    "scored_nodes": 1, "tree": true}
    },
    "usage": {"context_tokens": 13, "media_tokens": 1102, "scored_rows": 15}
  }],
  "usage": {"prompt_tokens": 1244, "cached_tokens": 129, "context_tokens": 13,
            "media_tokens": 1102, "scored_rows": 15},
  "timings": {"prefill_ms": 338.2, "scoring_ms": 25.5, "total_ms": 363.6, "rounds": 1}
}
```

The text-only path is byte-for-byte unchanged: a string context becomes a single text segment and
goes through the same code.

---

## 2. Why the validation was not the hard part

Relaxing `contexts` to accept parts is trivial. The work is that the decision engine decodes **tokens
only**, and an image is not tokens:

| fact | where |
|---|---|
| contexts validated as non-empty strings | `tools/server/server-context.cpp`, old `handle_decision` |
| engine decodes 1-D token positions, no embeddings | `decision-engine.cpp`, `decode_parts`: `common_batch_add(batch, tok, pos0 + i, {seq}, false)` |
| branch scoring forks the trunk with `llama_memory_seq_cp` — it does not care how the trunk's KV was filled | `decision-engine.cpp`, `score_branches` |
| branch positions were computed as `shared.size() + prefix.size()` | same, old group loop — wrong once an image occupies positions |
| an image is embeddings + M-RoPE 2-D positions + a non-causal attention span; `llama.h` has no setter for any of it | `include/llama.h` |
| non-causal decode asserts on the ubatch size | `src/llama-context.cpp` |

**The seam** is `mtmd_helper_decode_image_chunk(ctx, lctx, chunk, embd, n_past, seq_id, n_batch,
&new_n_past, cb, data)` (`tools/mtmd/mtmd-helper.h`). It is public, takes an arbitrary sequence and
position, and owns the non-causal batching and M-RoPE internally. Combined with `seq_cp` trunks, an
image can be decoded into a decision trunk and the existing branch scoring runs unchanged on top.

The second insight: **the engine does not need to know about images at all**. It only needs to be
told "text of this many tokens, then opaque thing #3, then more text", and to use the position the
opaque thing reports instead of counting tokens.

---

## 3. Engine: segmented contexts and a decode callback

`tools/parallel-decision/decision-engine.h`:

```cpp
struct context_segment {
    enum kind_t { TEXT, MEDIA };
    kind_t   kind  = TEXT;
    tokens_t toks;       // TEXT: tokens to decode causally at the running position
    int      media = -1; // MEDIA: index into the caller's list of encoded media

    static context_segment of_text(tokens_t t);
    static context_segment of_media(int index);
};

// decode media `media_index` into (seq, pos); return the position after it
using media_decoder = std::function<llama_pos(llama_seq_id seq, llama_pos pos, int media_index)>;

batch_result decide_batch_media(const std::string & shared_text,
                                const std::vector<std::vector<context_segment>> & contexts,
                                const std::vector<field_input> & fields, const options & opt,
                                const media_decoder & decode_media);
```

`decide_batch()` is now a thin wrapper, which is what keeps the text path from drifting:

```cpp
batch_result engine::decide_batch(...) {
    const tokens_t shared = tokenize_text(vocab, shared_text, true);
    std::vector<std::vector<context_segment>> segments;
    for (const auto & text : contexts) {
        segments.push_back({ context_segment::of_text(tokenize_text(vocab, text, shared.empty())) });
    }
    return decide_batch_media(shared_text, segments, inputs, opt, media_decoder());
}
```

### Group prefill in rounds

Per group (the contexts that fit the sequence budget together), each context gets one trunk sequence
copied from the cached prefix (`llama_memory_seq_cp`). Then the segments are walked in **rounds**:

```text
contexts:  A = [text, image, text]     B = [text]     C = [text, image]

trunk A, trunk B, trunk C  <- one per context, forked from the cached prefix (seq_cp)

round 0   decode_parts( text(A[0]) + text(B[0]) + text(C[0]) )   <- one packed batch
          decode_media( A, trunk A )                            <- helper, serial
          decode_media( C, trunk C )                            <- helper, serial

round 1   decode_parts( text(A[2]) )                            <- packed batch

          -> branch scoring runs once, per field, over every trunk
```

The text of each round is packed into one batch so prefilling keeps its throughput; only the images
are serial, because a media decode owns its sequence and its own non-causal batching.

The loop (abridged):

```cpp
size_t n_rounds = max over contexts of contexts[i].size();
for (size_t r = 0; r < n_rounds; ++r) {
    std::vector<prompt_part> parts;
    std::vector<size_t>     media_ctx;
    for (size_t i = 0; i < n_group; ++i) {
        if (r >= contexts[g0 + i].size()) continue;           // this context has no segment r
        const auto & seg = contexts[g0 + i][r];
        if (seg.kind == context_segment::TEXT) {
            parts.push_back({ &seg.toks, end_pos[i], seq_pool + i });
            end_pos[i] += seg.toks.size();
            text_tokens[i] += seg.toks.size();
        } else {
            media_ctx.push_back(i);
        }
    }
    decode_parts(parts);                                   // text keeps its batching
    for (size_t i : media_ctx) {                           // only images are serial
        end_pos[i] = decode_media(seq_pool + i, end_pos[i], contexts[g0 + i][r].media);
    }
    if (!media_ctx.empty()) llama_synchronize(ctx);        // bill the image to prefill, not scoring
}
```

Two details that make or break it:

- **`end_pos[i]`, never a token sum.** For M-RoPE an image can advance the position by a different
  amount than its token count. The helper's `new_n_past` is the truth, and it becomes the branch
  `pos0` and the next text segment's `pos0`.
- **Media is opaque to the engine.** It sees an integer index and a `std::function`; the engine has no
  mtmd dependency and never touches an embedding.

Branch scoring is untouched: it still does `llama_memory_seq_rm(seq); llama_memory_seq_cp(trunk, seq)`
and decodes the field suffix at `pos0 = end_pos[i]`. Because `seq_cp` copies KV cells, the branches
inherit the image exactly like they inherit text.

---

## 4. Server: parse, render, tokenise, encode, decode

All of it in `handle_decision()` (`tools/server/server-context.cpp`), on the same server thread that
owns the context.

### 4.1 Parse

A context is a string, or an array of parts. Parts are joined text parts plus media parts, each a
base64 data URL. This cut took exactly one `image_url`; cut 2 (§10) lifted that to any number of
`image_url` and `input_audio` parts. Rejections are specific 400s (see §6). `handle_media()` (now
exported from `server-common.h`) does the base64 decoding.

### 4.2 Render the marker into the per-request tail

`render_prompt()` gained optional `media_markers`, appended to the user message after the sentinel:

```cpp
usr.content = sentinel + markers;   // markers = one get_media_marker() per media part
...
return { prompt.substr(0, at), context + prompt.substr(at + sentinel.size()) + "{\n" };
```

So the static head (system prompt + template boilerplate) stays cacheable and identical across
contexts, while the markers land in the tail after the context text — text first, then the media in
part order.

### 4.3 Tokenise through mtmd

The tail carries one marker per media part; `process_mtmd_prompt()` turns it into text tokens around
one chunk per marker. It gained an `add_special` parameter, because the tail is tokenised separately
from the cached head and must not get a second BOS:

```cpp
tokenized.push_back(process_mtmd_prompt(mctx, tail, ctx.media, init_opt,
                                        /*is_placeholder*/ false, /*add_special*/ shared.empty()));
```

`server_tokens` gives back a flat token list with media placeholders. A new accessor,
`server_tokens::media_chunks()`, returns the media spans in order, so the walk is trivial:

```cpp
for (size_t idx = 0, next = 0; idx < st.size();) {
    if (next < media.size() && media[next].first == idx) {     // media starts here
        if (!text.empty()) { segments[i].push_back(of_text(std::move(text))); text.clear(); }
        segments[i].push_back(of_media((int) media_chunks.size()));
        media_chunks.push_back(media[next].second);
        idx += mtmd_input_chunk_get_n_tokens(media[next].second);
        ++next;
    } else {
        text.push_back(st[idx]);                               // ordinary token
        ++idx;
    }
}
```

### 4.4 Encode once, decode through the callback

Each image chunk is encoded once per request with the same batch API the chat path uses
(`mtmd_batch_init` → `mtmd_batch_add_chunk` → `mtmd_batch_encode` → `mtmd_batch_get_output_embd`).
The batches stay alive for the whole scoring pass because the embeddings are pointers into them.
Then the engine gets its callback:

```cpp
decode_media = [&](llama_seq_id seq, llama_pos pos, int idx) -> llama_pos {
    llama_pos     new_n_past = pos;
    const int32_t rc = mtmd_helper_decode_image_chunk(mctx, ctx_tgt, media_chunks[idx], media_embds[idx],
                                                      pos, seq, llama_n_batch(ctx_tgt), &new_n_past,
                                                      nullptr, nullptr);
    if (rc != 0) throw std::runtime_error("failed to decode the image into a decision branch (rc = ...)");
    return new_n_past;
};
```

### 4.5 The ubatch guard

The non-causal attention span of one image cannot be split across ubatches, and the core asserts on
it. Instead of aborting the process, the request is checked before decoding:

```cpp
const size_t n_ubatch = llama_n_ubatch(ctx_tgt);
for (const auto * chunk : media_chunks) {
    const size_t n = mtmd_input_chunk_get_n_tokens(chunk);
    if (n > n_ubatch) {
        throw std::invalid_argument("image needs " + std::to_string(n) +
                                    " tokens, raise --ubatch-size to at least " + std::to_string(n));
    }
}
```

This is the crash that was hit with `--ubatch-size 512` and a 1102-token image; it is now a clean 400.
Cut 2 makes the check per chunk type — a causal span can be split, an image's cannot (§10).

---

## 5. Caching and cost

| thing | cached? |
|---|---|
| static prefix (system + instructions + field catalogue) | yes, across requests (`cached_tokens`) |
| text part of a context | no, re-prefilled (same as before) |
| image embeddings / image KV | **not yet** — encoded and decoded every request |

That last row is the known cost and an explicit follow-up: the chat path already hashes bitmaps for a
prompt cache, and the same could be reused. For the test image the image work is ~320–400 ms of the
~0.68 s warm wall, so an image cache would be the single biggest win.

### What the timings cover

`timings.prefill_ms` is the cached prefix plus the text prefill plus the image **decode** (the helper's
`llama_decode`), with an explicit `llama_synchronize` so it is not billed to scoring.
`timings.scoring_ms` is the branch decodes. The mtmd **encode** of the image runs in the server before
the engine is called, so it is *not* in `timings` — the wall clock is ~330–400 ms higher than
`timings.total_ms` on a cold image. Billing it (e.g. a `timings.media_encode_ms`) is a follow-up.

### Measured (gemma-4-12b + mmproj-F16, RTX 4090, `--ubatch-size 2048`, 73760.png 2310×3072)

| | `/v1/decision` | `/v1/chat/completions` |
|---|---|---|
| answer | `{hands: 2, legs: 2, type: animal}` | same, as 33 generated tokens |
| evidence | per-field probability (`0.9998 / 1.0 / 1.0`) | none |
| warm wall | 0.68 s (`timings` 338 ms prefill + 26 ms scoring, +encode) | 0.77 s (prompt 64 ms cached + predict 427 ms) |
| cold wall | 1.01 s (`timings` 609 + 26) | 1.31 s (prompt 472 + predict 432) |
| media tokens | 1102 | 1102 (reused from the prompt cache when warm) |
| answer shape | always on-schema by construction | on-schema via the json_schema grammar |

Text parity, old vs new binary, same 3-context request: identical decisions, every probability
(`0.778575 / 0.990338 / 0.916570 / 0.955586`), `scored_rows 42`, `prompt_tokens 180`,
`cached_tokens 116` warm. One caveat on the chat side: without
`chat_template_kwargs: {"enable_thinking": false}` the model stays in thinking mode, fills the budget
with `reasoning_content` and returns `content: ""` / `finish_reason: "length"` — the decision engine
already disables thinking. `quickstart.py` sets it on the chat request and fails loudly if it ever
happens anyway.

`llama-parallel-decision` (the CLI) still builds and answers its stdin protocol unchanged
(`blue / 0.998337`).

---

## 6. Limits and errors

| input | result |
|---|---|
| string context | unchanged text path |
| array of `text` parts | joined, text path |
| `text` + any number of `image_url` / `input_audio` parts | media path, encoded and decoded in part order |
| `input_video` | `400 video input is not supported by "contexts": send frames as "image_url" parts` |
| `input_audio` without `data` / `url` | `400 an "input_audio" content part needs "data" or "url"` |
| non-data image URL (`http://`, `file://`) | `400 a decision image must be a base64 data:image/... URL` |
| no `mmproj` / no vision | `400 image input is not supported - hint: ... provide the mmproj` |
| no audio encoder | `400 audio input is not supported - hint: ... provide the mmproj` |
| a non-causal chunk bigger than `--ubatch-size` | `400 image needs N tokens, raise --ubatch-size to at least N` |

After every one of those the server is still `loaded`. Cut 2 (§10) lifted the one-image limit and
added audio; video is still a non-goal, because mtmd has no video chunk type — its video helper
hands the projector frames as image bitmaps.

---

## 7. Files touched

| file | change |
|---|---|
| `tools/parallel-decision/decision-engine.h` | `context_segment`, `media_decoder`, `decide_batch_media`, `tokenize_text`, `render_prompt(media_markers)` |
| `tools/parallel-decision/decision-engine.cpp` | segmented group prefill in rounds, `end_pos` branch positions, `decide_batch` wrapper |
| `tools/server/server-context.cpp` | `handle_decision`: parse parts, render marker, build segments, encode, decode callback, ubatch guard, `media_tokens` |
| `tools/server/server-common.h/.cpp` | `process_mtmd_prompt(add_special)`, `server_tokens::media_chunks()`, `handle_media` exported |
| `tools/parallel-decision/README.md` | "Media contexts" section |

Nothing in `include/llama.h` changed: M-RoPE positions stay inside the mtmd helpers. `/v1/chat/completions`
is untouched.

---

## 8. How to reproduce

```bash
# server (needs an mmproj and --decision-seqs for the decision endpoint)
build/bin/llama-server -m gemma-4-12b.gguf --mmproj gemma-4-12b-mmproj-F16.gguf \
    --decision-seqs 12 --jinja -ngl 99 --ubatch-size 2048 --port 8060

# both endpoints, one image, with a comparison; from decision-playground/
python scripts/quickstart.py C:\Users\me\Downloads\73760.png \
    --server http://127.0.0.1:8060 --model gemma-4-12b
```

`quickstart.py` sends the same instructions/image/schema to both endpoints, prints the answer,
probabilities, usage and timings, and exits non-zero if they disagree.

---

## 9. Follow-ups

1. **Image-embedding / image-KV cache**, keyed on a bitmap hash like the chat path already does — the
   largest remaining cost.
2. **Bill the media encode** in `timings` (today it is only visible in the wall clock).
3. ~~Multiple images per context~~ — done, cut 2 (§10).
4. ~~Audio parts~~ — done, cut 2 (§10). Video is still open: mtmd has no video chunk type, so frames
   have to arrive as `image_url` parts.
5. Retire `scripts/decision-image-proxy.py`: it still needs no fork to run, but it pays two hops and
   answers from generated prose. `/v1/decision` now does it in one pass and on the pixels.

---

## 10. Cut 2: several media parts and audio

Cut 1 accepted one image per context because that is all the encode/decode path had been exercised
for. Nothing below the parser cared: `context_segment` is a list, the group loop already decodes one
media segment per context per round, and the walk already collected every chunk `mtmd` reported. So
cut 2 is a parser change plus two details.

**Parse.** `parsed_context::images` became `media`, and a part is now one of `text`, `image_url`
(base64 `data:image/...`), `input_audio` (`input_audio.data` raw base64 or a data URL, or
`input_audio.url`; the same keys the chat path reads), or `input_video`, which stays a 400. The
support flags are per encoder (`mtmd_support_vision` / `mtmd_support_audio`), not per mmproj.

**Markers.** `render_prompt()` already took a list of markers; the call site built one. It now builds
one `get_media_marker()` per media part, so `mtmd_tokenize` returns one chunk per marker in part
order, and the segment walk turns that into `[TEXT, MEDIA, ...]`. Markers still come after the context
text, so a context reads text first, then its media; `end_pos` from the helper keeps positions right
across consecutive media.

**The ubatch guard.** The old guard applied to every chunk. A non-causal span cannot be split across
ubatches; a causal one can, and `mtmd_helper_decode_image_chunk` splits it itself. The guard now
skips chunks for which `mtmd_decode_use_non_causal()` is false (audio, and Gemma's causal image
projectors), so a long recording is not rejected for being long.

Measured on gemma-4-12b + mmproj-F16 (RTX 4090, `--ubatch-size 2048`, one request per row, warm
prefix; the same mmproj carries both encoders — `clip.has_vision_encoder` and `clip.has_audio_encoder`):

| context | answer | media tokens | prefill / scoring |
|---|---|---|---|
| text only | `{hands: 4, legs: 4, person}` (from prose) | 0 | 349 / 31 ms |
| one 2310×3072 image | `{hands: 2, legs: 2, animal}` | 1102 | 339 / 25 ms |
| that image + a 512×512 png | same answer | 1223 (1102 + 121) | 500 / 24 ms |
| that image + a 2 s 16 kHz wav | same answer | 1152 (1102 + 50) | 352 / 24 ms |
| two contexts: image, then text | one result each, order kept | 1102 | 318 / 25 ms |

Audio is not merely accepted, it conditions the answer: two contexts, one with a SAPI-recited
sentence ("the server room temperature is critical, please evacuate") and one with a 220 Hz tone,
answered `{speech: true, topic: server_room}` (`p = 1.000 / 1.000`) and `{speech: false,
 topic: none}` (`0.932 / 0.999`) - 165 and 50 media tokens. Paired media in paired contexts stays
isolated (the photo answered `animal`, a red square answered `object`, both `p = 1.000`), the chat
endpoint still takes the same audio part, and every rejected request left the server `loaded`.
