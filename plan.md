# Media contexts for `/v1/decision`

Plan for letting `POST /v1/decision` accept image content parts, so schema fields are scored
**directly conditioned on the pixels** — one batched pass, no intermediate caption, probabilities
computed from the image itself.

Branch: `parallel-decision-media` (off `parallel-decision`). Commit prefix: `parallel-decision : ` /
`server : `, matching the existing history.

## Goal

```jsonc
POST /v1/decision
{
  "model": "gemma-4-12b",
  "instructions": "…",
  "contexts": [[                                  // string OR array of parts
    {"type": "text", "text": ""},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,…"}}
  ]],
  "schema": { "type": {"type":"enum","choices":["animal","person","object"], …} },
  "mode": "auto"
}
```

Same response shape as today (`results[].decision`, `results[].fields[].probability`, `usage`,
`timings`), plus `usage.media_tokens` per result.

## Non-goals (first cut)

- One image per context. Audio/video and multiple images per context return a clear 400.
- No change to the text-only path: same tokens in, same answers out, byte for byte.
- No new public `llama.h` API (M-RoPE positions stay inside the mtmd helpers).
- No image-embedding cache (a follow-up: the server already hashes bitmaps for chat).
- `/v1/chat/completions` untouched.

## Why the validation alone is not enough

| fact | where |
|---|---|
| `contexts` must be 1–256 non-empty strings | `server-context.cpp:2382-2399` |
| the engine decodes **tokens only**: `common_batch_add(batch, tok, pos0 + i, {seq}, false)` — 1-D positions, no embeddings | `decision-engine.cpp:196-215` (`decode_parts`) |
| branch scoring forks the trunk with `llama_memory_seq_cp` — **it does not care how the trunk's KV was filled** | `decision-engine.cpp:238-285` (`score_branches`) |
| branch positions are computed as `shared.size() + prefixes[i].size()` — wrong once image tokens occupy positions | `decision-engine.cpp:410` |
| non-causal assert: `n_ubatch >= n_tokens_all` for the decode batch | `src/llama-context.cpp:1736` |
| image tokens = embeddings + M-RoPE 2-D positions + a non-causal span; no public API for any of it | `include/llama.h` has no `mrope`/position setter |

**The seam:** `mtmd_helper_decode_image_chunk(ctx, lctx, chunk, embd, n_past, seq_id, n_batch, …)`
(`tools/mtmd/mtmd-helper.h:100+`) is public and takes an arbitrary sequence + position, handling the
non-causal span and M-RoPE internally. Combined with `seq_cp` trunks, an image can be decoded into a
decision trunk and the existing branch scoring runs unchanged on top of it.

Other pieces to reuse:
- `process_mtmd_prompt(mctx, prompt, files, init_opt)` — `server-common.h:275`: marker-bearing prompt
  + raw files → `server_tokens` (text tokens, image chunks, positions).
- `get_media_marker()` — the marker the chat template emits for a media part.
- `common/chat.cpp:199-208`: template rendering emits `media_marker` parts in content order.

## Design

### Engine: segmented contexts + a decode callback

`decision-engine.h`:

```cpp
struct context_segment {
    enum kind_t { TEXT, MEDIA } kind = TEXT;
    tokens_t toks;        // TEXT: tokens to decode causally at the running position
    int      media = -1;  // MEDIA: index into the caller's list of encoded media
};

// Decodes media into (seq, pos) and returns the position after it (n_past semantics as reported by
// the mtmd helper). Called on the engine's own context, from the engine's thread.
using media_decoder = std::function<llama_pos(llama_seq_id seq, llama_pos pos, int media_index)>;

batch_result decide_batch_media(const std::string & shared_text,
                                const std::vector<std::vector<context_segment>> & contexts,
                                const std::vector<field_input> & fields,
                                const options & opt,
                                const media_decoder & decode_media);
```

- `decide_batch(shared, contexts, …)` becomes a thin wrapper: each string → `{{TEXT, tokenize(text, shared.empty())}}`, then `decide_batch_media` with an empty callback. One implementation, so the text path cannot drift.
- Group loop (`decision-engine.cpp:380-420`): per context, walk segments in order, decoding in
  **rounds** — all contexts' text for round *r* in one packed batch (existing `decode_parts`), then
  each context's media chunk via `decode_media` — so text prefill keeps its batching and only the
  images are serial.
- Track `end_pos[i]` per context (advanced by the callback's return value) and use it for the branch
  `pos0` instead of `shared.size() + prefixes[i].size()`.
- `llama_synchronize(ctx)` after a media decode so its time is billed to prefill, not scoring.
- No mtmd dependency: the engine only sees integers and a `std::function`.

### Server: parse, tokenize, decode

`server-context.cpp` `handle_decision()`:

1. **Parse** each `contexts[i]`: string → text context (unchanged). Array → collect `text` parts and
   media parts; media must be `image_url` with a data URL (base64). Reject audio/video, >1 image,
   and media on a model without `mctx` — 400 with a specific message each.
2. **Render** with the media marker in place. `render_prompt()` gains an optional list of media
   markers to place next to the sentinel, so the head/tail split still works and the marker lands in
   the per-context tail (text first, then image — the order the caller sent).
3. **Tokenise** the tail with `process_mtmd_prompt(mctx, tail_with_marker, files, init_opt)` →
   `server_tokens`: walk its chunks and build `context_segment`s (text tokens around image chunks).
4. **Encode** each image chunk once per request: `mtmd_batch_init` → `mtmd_batch_add_chunk` →
   `mtmd_batch_encode` → `mtmd_batch_get_output_embd(batch, chunk)` (`tools/mtmd/mtmd.h:338-351`) —
   the same sequence the chat path uses in `process_mtmd_chunk` (`server-context.cpp:750-800`). The
   batch must stay alive until scoring finishes: the embeddings are pointers into it.
5. **Decode callback**:
   ```cpp
   auto decode_media = [&](llama_seq_id seq, llama_pos pos, int idx) -> llama_pos {
       llama_pos new_n_past = pos;
       int rc = mtmd_helper_decode_image_chunk(mctx, ctx_tgt, chunk[idx], embd[idx], pos, seq,
                                              llama_n_batch(ctx_tgt), &new_n_past, nullptr, nullptr);
       if (rc != 0) throw std::runtime_error("failed to decode the image into a decision branch");
       return new_n_past;
   };
   ```
6. **Guard the assert**: before decoding, compare the image's token count with `llama_n_ubatch(ctx)`
   and fail with `400 image needs N tokens, raise --ubatch-size to at least N` instead of aborting
   the process (this is the crash we hit with `ubatch-size 512`).
7. Report `usage.media_tokens` and keep the existing `prompt_tokens` / `cached_tokens` /
   `scored_rows` semantics.

## Test plan

Build: `cmake --build build --config Release -j` (CUDA). **`build\bin\llama-server.exe` is locked
while the server runs — the server must be stopped before the relink.** Keep a copy of the current
binary to fall back to.

Fallback if the change breaks the text path:
`copy build\bin\llama-server.exe build\bin\llama-server.media.exe` before rebuilding.

1. **Text parity** — run the same decision request (image-classification preset context) before and
   after the change; `decision`, every `probability`, `scored_rows` and `prompt_tokens` must match.
2. **Image decision** — the `hands`/`legs`/`type` schema with `73760.png` as a part: expect
   `animal / 2 / 2`, one pass, `timings.total_ms` well under the 0.72 s the shim needs for two hops.
3. **Image + text** — a ticket sentence plus a screenshot; both must influence the answer, and the
   text part must still hit the cached shared prefix.
4. **Batch** — two contexts in one request (one with an image, one plain text) → two results, order
   preserved, `scored_rows` for both.
5. **Errors** — no `mmproj`; two images; an `input_audio` part; an image larger than `ubatch-size`.
   Each must be a JSON 400, never a crash. Then confirm the server is still `loaded`.
6. **CLI unaffected** — `llama-parallel-decision` still builds and answers its stdin protocol.

## Risks

| risk | mitigation |
|---|---|
| image decode aborts the process on the ubatch rule | explicit token-count pre-check (#6) before decoding |
| branch positions after an image (M-RoPE) | use the helper's `new_n_past`, never a token-count sum |
| KV pressure: image cells live in trunk sequences, branches share them via `seq_cp` | group sizing already bounds trunks/branches by `n_pool`; on `rc == 1` the engine already reports "no free KV cache space" |
| text path regression | `decide_batch` kept as a wrapper; test 1 pins it |
| relink blocked by the running server | stop the server first; keep the previous binary |
| per-request image encode (~0.7 s for 2310×3072) | out of scope; the shim and chat path pay the same. Follow-up: reuse the server's bitmap-hash cache |

## Deliverables

1. `tools/parallel-decision/decision-engine.{h,cpp}` — segments + callback, branch positions.
2. `tools/parallel-decision/decision-engine.cpp` `render_prompt` — media marker variant.
3. `tools/server/server-context.cpp` — parse parts, tokenise, encode, decode, guard, usage.
4. `tools/parallel-decision/README.md` — a short "Media contexts" section next to `POST /v1/decision`.
5. This file's test plan executed, with the measured numbers recorded in the commit message.

## Relationship to the shim

`decision-playground/scripts/decision-image-proxy.py` already gives clients the same request shape
by asking the vision model to describe the image and passing that text to `/v1/decision` (0.72 s,
two hops). That stays useful — it needs no rebuild and no fork — but this change is strictly better:
no generated intermediate text, probabilities conditioned on the pixels, one pass. The shim can be
retired once this lands.
