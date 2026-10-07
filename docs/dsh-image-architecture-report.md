# How dsh models, transports, stores, and renders images in the message stream

Read-only investigation of `E:\RJ\DmRJ\deepseek-harness` at `origin/master` = `5badb15009`
(0.2.1-alpha.1, 2026-10-03). The checkout working tree (`47f943859b`, 2026-08-13) was **not**
modified; every reference below is `origin/master`.

> **Scope note.** This report is deliberately asymmetric toward the data model and transport,
> because that is what has to be reimplemented. Rendering is described in enough detail to
> rebuild it, but the load-bearing content is §1, §4, §6.

---

## 0. The one-paragraph answer

An image is **never inline base64 in the session log and never a filesystem path or URL**.
It is a *durable reference* — `ImageAttachmentRef` — with a content-addressed opaque id
(`sha256:<64 hex>`) plus intrinsic metadata (`mediaType`, `bytes`, `width`, `height`,
optional `name`, optional `originalDimensions`). The bytes live in a host-side
content-addressed object store (`DSH_HOME/attachments/v1/objects/<aa>/<sha256>`). The session
event carries only the reference. The browser fetches bytes over an authenticated RPC
(`session.attachment`) and turns them into a `blob:` URL. The model gets a **real multimodal
part** (base64 or a provider file id) for vision routes, and a deterministic **text
placeholder** for text-only routes; there is a third state, `offloaded`, where an image is
permanently replaced by placeholder text because the request exceeded the route's image budget.

---

## 1. The content-block model

### 1.1 The union

`packages/llm/llm/src/types.ts:137-150` — verbatim:

```ts
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support. Tool-change blocks belong to
 * developer messages; `projectToolUpdates` selects what each route receives.
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-addition': ToolAdditionBlock
  'tool-removal': ToolRemovalBlock
}

/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
export type ContentBlock = ContentBlockMap[ContentBlockType]
```

The per-kind payloads (`packages/llm/llm/src/types.ts:66-...`), verbatim:

```ts
/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user messages may carry images.
 */
export interface ImageBlock {
  type: 'image'
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef
  /**
   * Derived from a durable image-offload decision or preserved by a message
   * rewrite. Every route sends placeholder text naming the image and its
   * available read-only path instead of image bytes.
   */
  offloaded?: true
}

/**
 * A durable verbatim file reference, valid in user content. Files never reach
 * a provider natively: request assembly projects every occurrence to
 * deterministic handle text (name, byte size, and the read-only saved path),
 * so adapters and providers see text in its place while the durable log keeps
 * the structured reference for presentation and authorization.
 */
export interface FileBlock {
  type: 'file'
  /** Immutable verbatim bytes and display metadata owned by the attachment service. */
  attachment: FileAttachmentRef
}
```

**Answer to "how does an image block reference its bytes":** not inline base64, not a path,
not a URL. An opaque **attachment id** (a sha256 digest string), plus mime type, exact byte
length, and intrinsic dimensions. The id is explicitly *not* a bearer token and *not* a path.

### 1.2 The reference type

`packages/attachment/attachment/src/types.ts` — verbatim:

```ts
/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable reference to one immutable normalized image. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}
```

Note the design constraints encoded in these doc comments:

- `attachmentId` is *deliberately* opaque — the client must never parse it or derive a path
  from it (`packages/client/ui-tool/src/client/tool/models/image-card-model.ts` repeats this
  as a hard rule: "it is opaque and provider-owned, and consumers must not parse that
  representation").
- `width`/`height` are the **post-normalization** dimensions; `originalDimensions` is present
  only when storage downscaled.
- The display `name` is stripped of local path information.

### 1.3 How the model's own messages differ

`BlockAssembler` (`packages/llm/llm/src/assembler.ts:113-127`) can only assemble `text`,
`reasoning`, and `tool-call` blocks from a stream. There is no streamed image block path, so
**assistant output never introduces an image block today** — matching the `ImageBlock`
doc comment above.

---

## 2. Where images can actually appear

Exhaustive enumeration on master. The gates that matter: an image block can only be produced
in a **user** message or a **tool/result** message (the assistant path is dead code today).

### 2.1 User attachment / composer upload — `prompt()` with base64 parts

Client side, the composer holds a browser-only draft; on submit it serializes to base64 and
sends it **inline with the prompt** (`packages/client/ui-conversation/src/client/service.ts:576-583`):

```ts
  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File): Promise<Omit<Extract<SubmitAttachment, { type: 'image' }>, 'type'>> {
    return {
      mediaType: imageMediaType(file.type),
      data: await base64ImageOf(file),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }
```

`base64ImageOf` uses `FileReader.readAsDataURL` and slices off the `data:…,` prefix
(`service.ts:117-129`) — "Native canonical base64 … no main-thread byte loop".

The wire type is `EncodedImageAttachment` or `PromptContentPart`
(`packages/attachment/attachment/src/types.ts`):

```ts
/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/**
 * Browser-submitted prompt content accepted by Host prompt endpoints; the
 * accepting Host promotes image parts to durable references through
 * `ctx.attachments.admitPromptContent()` before any message is created, so a wire caller can
 * never cite an attachment it did not upload.
 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }
```

And the admitted form, which is what lands in the log:

```ts
/** Host-admitted prompt content with every attachment represented by its durable reference. */
export type AdmittedPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
```

**Key architectural point for a port:** the browser sends *bytes* once, over the prompt
submission; the host normalizes, hashes, stores, and rewrites the part into a *reference*. The
session log therefore never contains the base64.

### 2.2 Tool result that returns an image — `read_image`

`packages/fs/tool-fs/src/read-image.ts` — the tool's `output.render` projects the structured
outcome into **two content blocks**:

```ts
/**
 * Project one structured image read into its model-facing envelope and image.
 * @param value - the image-read outcome.
 * @returns the two content blocks used by native and nested dispatches.
 */
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}
```

See §3 for the full detail.

### 2.3 Tool result that returns an image — MCP tools

`packages/mcp/mcp-client/src/tools.ts:375-440`. MCP `image` content blocks are decoded,
preflighted as a **batch**, durably saved, then projected at their original position:

```ts
function imageDiagnostic(block: McpContentBlock, reason: string): string {
  const mediaType = block.mimeType ?? 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}
```

```ts
  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset] as ImageAttachmentRef] as const))
    return projectContent(content, toolName, (_block, index) => ({
      type: 'image',
      attachment: byIndex.get(index) as ImageAttachmentRef,
    }))
  } catch (error: unknown) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result'
    return projectContent(content, toolName, block => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    }))
  }
```

**All-or-nothing semantics worth copying:** if *any* image in one MCP result fails
validation or admission, **every** image in that result degrades to diagnostic text. The
`projectContent` signature shows the default projector is the degrade-to-text one:

```ts
function projectContent(
  mcpContent: JsonValue[],
  toolName: string,
  image: (block: McpContentBlock, index: number) => ContentBlock = block => ({
    type: 'text',
    text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
  }),
): ContentBlock[] {
```

### 2.4 Computer-use / browser screenshots

**Not present on master.** `packages/computer-use/**` contains only a registry and
thinker/driver seams; `git grep -rln "screenshot" -- "packages/**/src/**/*.ts"` returns
nothing. There is no dsh-side screenshot tool that produces an image block. If your tool has
one, treat it exactly like §2.3 (a tool result whose content is `[text, image]`).

### 2.5 Assistant-generated image

**No path exists.** `BlockAssembler` has no image case (§1.3), and the `ImageBlock` doc comment
states the current production adapters declare text-only output. The block is role-neutral
purely as forward compatibility, and the *client* does render an assistant-side image block
(`toAssistantBlock` → `{ kind: 'image', attachment }`) — so if you add one, only the
server-side stream assembly needs new code.

### 2.6 Pasted image

Paste is **not** a separate path — it funnels into the same intake as drag-and-drop.
`packages/client/ui-conversation/src/client/input/editor/keymap.ts:158-188`:

```ts
    editor.registerCommand(PASTE_COMMAND, (event) => {
      // Duck-typed: the payload union includes InputEvent, and test engines
      // deliver clipboardData on plain events.
      const clipboardData = (event as ClipboardEvent).clipboardData ?? null
      if (clipboardData === null) return false
      const files: File[] = []
      const directories = new Set<File>()
      for (const item of clipboardData.items) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file === null) continue
        files.push(file)
        if (typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory === true) {
          directories.add(file)
        }
      }
      if (files.length > 0) handlers.intakeFiles(files, directories.size === 0 ? undefined : directories)
      const text = clipboardData.getData('text/plain')
      if (text === '') {
        if (files.length === 0) return false
        event.preventDefault()
        return true
      }
      event.preventDefault()
      handlers.pasteText(text)
      return true
    }, COMMAND_PRIORITY_CRITICAL),
```

**Selection rule:** the browser-declared MIME decides. `isImageMediaType` (service.ts) accepts
exactly the four raster types; anything else becomes a *file* draft that goes through the
separate raw-byte upload route with a `receiptId`.

### 2.7 Summary table

| Entry point | Produced by | Block type in the log | Bytes first travel as |
|---|---|---|---|
| Composer attach / drop / paste | `ConversationController.submit` | `{type:'image', attachment: ImageAttachmentRef}` | base64 in `session.prompt` RPC |
| `read_image` tool | `output.render` in `read-image.ts` | same | host-local file read, never over the wire |
| MCP tool result with `image` content | `prepareImageProjection` | same | MCP transports base64 to the host |
| Assistant message | — | **no path** | — |
| Computer-use screenshot | — | **no path** | — |

---

## 3. `read_image` specifically

### 3.1 Definition

Package: `packages/fs/tool-fs`, file `src/read-image.ts`. Registered from `applyReadImageTool`,
which `src/index.ts` calls inside `ctx.inject(['attachments'], …)` so the tool exists only
while a durable store is mounted. Verbatim tool declaration:

```ts
  ctx.tools.register(defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. '
      + 'Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageReadContent(value),
      // Persist the resolved path only. The attachment reference is NOT copied
      // here: the settled `content` already carries the image block with the
      // complete reference, so a second copy would keep two records of one fact —
      // and a `tools/post-execute` hook that legitimately replaces the content
      // would leave the stale copy behind, showing an image the result no longer
      // returns. The path needs its own structured record because the content
      // carries it only as model-facing envelope text, which the client does not
      // parse.
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Content-addressed attachment writes are idempotent, so concurrent reads
    // of the same file cannot conflict.
    isConcurrencySafe: () => true,
```

This `presentationMeta` comment is one of the most important design lessons in the repo:
**the durable content is the single source of truth for the reference; presentation metadata
carries only what the content does not** (here, the path). The client-side model repeats the
rationale (`image-card-model.ts`).

### 3.2 The output schema and structured value

`IMAGE_VALUE_SCHEMA` is a hand-written JSON schema mirroring `ImageAttachmentRef` minus the
brand. The declared value type:

```ts
/** The structured outcome declared by the `read_image` output schema. */
export interface ImageReadValue {
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    /** Orientation-applied file dimensions before normalization; present only when storage reduced it. */
    originalDimensions?: {
      width: number
      height: number
    }
  }
}
```

Re-branding back into the block's reference:

```ts
export function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}
```

### 3.3 The model-facing envelope

```ts
export function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string {
  let scaled = ''
  if (image.originalDimensions !== undefined) {
    // Integer rounding can give the two axes slightly different ratios, so the
    // advice names one multiplier only when both round to the same value.
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y
      ? `multiply coordinates by ${x}`
      : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}
```

So the text envelope is **deliberately not the `read` tool's line-numbered format** and is
never parsed back by the client — it exists so the model can talk about resolution and
coordinate mapping. The client's image card reads it for the caption line.

### 3.4 Size / mime limits — the pre-I/O gate ladder

Execute refuses **before any filesystem I/O** ("so a refusal never leaks partial reads or
attachment writes"):

1. empty `file_path` → error;
2. an extension that is not `.png/.jpg/.jpeg/.webp/.gif` → error (`read_image accepts
   PNG/JPEG/WebP/GIF files, including extension-less files in those formats`);
3. no mounted attachment service → error;
4. declared media type not in `attachments.imageLimits.mediaTypes` → error;
5. **strict route gate** `assertImageCapableRoute` — the *calling route's* model must declare
   `image` in `inputModalities`, else:
   `cannot read "…" as an image: model "…" does not declare image input; switch to an
   image-capable model to read images`. Unknown capability **refuses** rather than relying on
   a later adapter failure.

Then the byte cap is the *tighter* of two bounds:

```ts
      // The tool result is one message carrying one image, so the per-message
      // aggregate bound applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
```

Extension-less paths are identified by **signature sniffing** (`sniffImageMediaType`, with
explicit PNG/JPEG/GIF87a/GIF89a/RIFF-WEBP checks). Storage admission then stays authoritative.

Error mapping from `AttachmentError` codes to recoverable, actionable tool errors:
`IMAGE_DIMENSION_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`, `IMAGE_TOO_LARGE`,
`ATTACHMENT_WRITE_FAILED` + 16-bit PNG, `INVALID_IMAGE`, `IMAGE_TYPE_MISMATCH`. The rationale
is stated in-code:

> Dimension refusals stay recoverable tool errors: an oversized image must never enter durable
> history, where it would ride every later model request past provider-side dimension
> rejections.

### 3.5 What the tool returns

The tool **returns the structured `ImageReadValue`**; the *content blocks* come from
`output.render`. The order of operations is explicit:

```ts
      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended.
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
```

`basename(target.displayPath)` is what becomes `ref.name` — the local path is never leaked.

### 3.6 The persisted event (this is the shape to copy)

From `snapshots/session/read-image/session.v3.jsonl` (pretty-printed here; it is one line in
the file):

```json
{"type":"tool/result","data":{
  "turn":1,"step":1,
  "message":{
    "source":{"kind":"tool","callId":"read-image-call"},
    "content":[{"type":"tool-result","toolCallId":"read-image-call","content":[
        {"type":"text","text":"<path>{{cwd}}/red.png</path>\n<type>image</type>\n<content>\nimage/png image, 1x1 px, 69 bytes\n</content>"},
        {"type":"image","attachment":{
          "attachmentId":"sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640",
          "mediaType":"image/png","bytes":69,"width":1,"height":1,"name":"red.png"}}
      ],"isError":false}],
    "role":"user","id":"{{message:5}}"},
  "meta":{"path":"{{cwd}}/red.png"}},
 "sourceEventSeqs":[14],"surfaceOp":"append"}
```

**No bytes.** 69 bytes of PNG are addressed by digest; the log stays small and diffable.

### 3.7 Commit history

Requested SHAs and what they are:

| SHA | Kind | Contents |
|---|---|---|
| `1861a3fc7c` | feat | `feat(fs): add a minimal read_image tool over the attachment and fs seams` — adds `packages/fs/tool-fs/src/read-image.ts` (231 lines), `tests/read-image.spec.ts` (462 lines), `readBytes` on the fs seam, `llm-replay` model `inputModalities`, tool catalog regeneration. |
| `6e17c20804` | feat | `read_image reports downscaled dimensions and coordinate scale` — 2 files: `read-image.ts` (+20/-2) and its spec (+35). Adds the `scaled` "multiply coordinates by …" advice in `formatImageReadOutput`. |
| `7222e17dc0` | fix | `accept extension-less attachment paths in read_image` — sniffing + trailing-dot/dotfile handling. |
| `97a9ec5a0e` | fix | review follow-ups: bound E2B `readBytes` at the seam, conditional-registration disposal, contract alignment. |
| `c90a944abd` | docs | zh config catalog + pinning read_image source fields in the code-mode prompt sidecar. |
| `9fcbeb8615`, `21ec0fd10b` | test | expect `read_image` in the shipped web composition / the CLI standard preset. |
| `8f86c22a9a` | refactor | review wording for send_message, job_kill, and read_image. |
| `a4d4404708` | feat | `feat(ui-tool): render read_image results as the image` — the UI half. |
| `56ca8af0ee` | feat | `feat(ui-tool): render the image card for nested read_image calls` — the `presentationMeta`-absent fallback. |

### 3.8 `a631115597` — "render read_image results as images"

It **is present**, and it is a **merge commit**:

```
commit a6311155976fadcec48dc6478369cbe5d97351b3
Merge: d921d4b357 3648331b11
    Merge pull request #2828 from deepseek-harness/feat/toolcard-image-result
    feat(ui-tool): render read_image results as the image
```

What it brought in (diff against its first parent, 63 files, +1381/-126). The decisive new files:

- `packages/client/ui-tool/src/client/tool/toolviews/read-image-row.tsx` (**new, 61 lines**) — the `read_image` keyed toolview.
- `packages/client/ui-tool/src/client/tool/toolviews/read-family-row.tsx` (**new, 59 lines**) — shared chrome for `read` and `read_image`.
- `packages/client/ui-tool/src/client/tool/toolviews/read-row.tsx` (changed, 27 lines) — refactored onto the shared family row.
- `packages/client/ui-tool/tests/image-card.client.spec.tsx` (**new, 384 lines**) — the coverage.
- `packages/fs/tool-fs/src/read-image.ts` (+9) — adds the `presentationMeta`.
- Snapshot fixtures including a new `read-image-gif` session.
- `packages/client/ui-primitives/src/client/slot-catalog.ts` (64 lines) and `packages/client/ui-tool/tsconfig.json` (3 lines).

The header comment of the new row file states the contract precisely:

```tsx
// read_image toolview registrant: the keyed toolview hole for the read_image
// tool. The row composes the shared read-family assembly and feeds it the durable
// image reference as ToolRow's `image` card material, so the image renders through
// the Tool-owned `tool.call.images` slot inside the collapsed-by-default expanded
// body — the same unified interaction every other card row has. The attachment
// presentation plugin fills that slot; the tool layer only ever supplies the
// references and the session-authorized loader it received from the chat node.
//
// Claiming the `read_image` key suppresses the generic fallback for EVERY
// read_image result, so this component must cover all of the tool's shapes, not
// only the happy one: a running call (no result yet), a settled image, a refusal
// (a text-only route, a missing attachment service, an unreadable file), and a
// cancelled call. Each of those settles without an `image` card, and the row falls
// back to its text body for them.
```

So `a631115597` is the commit that turns an image-bearing tool result into a rendered picture
in the transcript. Before it, `read_image` returned an image block that reached the model but
rendered as raw JSON in the tool card.

---

## 4. Transport & persistence — the core question

### 4.1 Rule: reference in the log, bytes off-log

**An image is never inline base64 in the session log.** There is no `dataUrl`, `data:image`,
or `blob` field in any durable event. The complete set of things the log stores is exactly the
`ImageAttachmentRef` fields quoted in §1.2.

The storage layout is content-addressed with a two-level fan-out
(`packages/attachment/attachment-local/src/store.ts:46-55`):

```ts
/**
 * Derive the absolute immutable-object path for one normalized attachment.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - durable normalized attachment reference.
 * @returns provider-local path without reading the object.
 */
export function normalizedImagePath(root: string, ref: ImageAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}
```

with `const ID_PATTERN = /^sha256:([a-f0-9]{64})$/` and the id derived as
`sha256(normalizedBytes)`:

```ts
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<PreparedImageFile> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  const normalized = await normalizeImage(input.data, detected, policy)
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled ? { originalDimensions: { width: detected.width, height: detected.height } } : {},
    },
  }
}
```

Two further details worth copying:

- **Path information is stripped by hand**, not via `path.basename`, because on a POSIX host
  `\` is an ordinary character and a Windows client path would leak (`store.ts:26-37`).
- **The digest is over the *normalized* bytes**, and `width`/`height` are the normalized
  dimensions, with `originalDimensions` recording the pre-normalization facts. Git-style
  dedup falls out for free.

### 4.2 Producer-side caps (admission)

`packages/attachment/attachment-local/src/index.ts:41-58` — verbatim:

```ts
/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
/** Default maximum intrinsic pixels for one submitted image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
/** Default per-side pixel cap for one submitted image. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192
/**
 * Default total-pixel budget of the stored normalized image. A larger source
 * is admitted and downscaled proportionally, so admission bounds what rides
 * every later model request without refusing ordinary large sources; extreme
 * aspect ratios keep their short-edge resolution instead of collapsing under
 * a long-edge rule.
 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048
/** Default long-edge cap of the stored normalized image, applied after the total-pixel budget. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192
/** Default encoded-byte target for one stored normalized image. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Conservative default number of simultaneous native image transformations per store. */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** Maximum configurable native image transformations per store. */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8
```

**Two-tier policy:** sources up to 20 MiB / 64 MP / 8192 px/side are *accepted*; anything
bigger is **refused, not shrunk** ("oversized sources are refused, not shrunk"). Accepted
sources are then *downscaled* to ≤ 4 MP / 8192 px long edge / 4 MiB. So the store holds a
bounded, normalized image, and admission is what keeps every later request bounded.

Batch caps are enforced in `packages/attachment/attachment/src/index.ts:78-85`:

```ts
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      …
    if (totalBytes > maxMessageImageBytes) {
```

### 4.3 What happens when a *request* exceeds the route budget — offload

This is the `compaction-image-offload` package, and it is the most interesting policy in the
repo. The premise: **a route never silently drops an image.** It refuses the request, reports
*how many* oldest occurrences must go, and a separate executor logs a durable decision and
retries.

The failure carries the count (`packages/llm/llm/src/types.ts:50-57`):

```ts
  /**
   * With code `IMAGE_OFFLOAD_REQUIRED`: how many more of the oldest retained
   * image occurrences the route needs offloaded before the same request fits
   * its exact byte accounting. `dsh-compaction-image-offload` records the
   * selected occurrences in an `image/offload` event and retries the step.
   */
  readonly offloadImages?: number
```

The budget shape:

```ts
export interface LlmImageRequestBudget {
  /** Whether the route accounts raw file bytes or inline base64 length. */
  representation: 'raw' | 'base64'
  /** Accumulated represented image bytes the route accepts; absent leaves bytes unbounded. */
  maxBytes?: number
  /** Image occurrences the route accepts; absent leaves the count unbounded. */
  maxImages?: number
  /** Represented bytes removed as one deterministic advance step; absent removes the minimum. */
  byteQuantum?: number
  /** Occurrences removed as one deterministic advance step; absent removes the minimum. */
  countQuantum?: number
}
```

The pure calculation (`packages/llm/llm/src/content.ts:280-330`):

```ts
function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * Number of oldest retained occurrences a route must still offload before a
 * derived request fits its budget at the exact byte length the route sends;
 * zero when the request fits. A route fails with `IMAGE_OFFLOAD_REQUIRED`
 * carrying this count instead of offloading on its own.
 */
export function requiredImageOffload(
  messages: readonly RequestMessage[],
  budget: Pick<LlmImageRequestBudget, 'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = []
  for (const message of messages) {
    visitImageBlocks(message.content, (block) => {
      if (block.offloaded === true) return
      const bytes = versionBytes(block)
      lengths.push(budget.representation === 'base64' ? base64Length(bytes) : bytes)
    })
  }
  return offloadedImagePrefixCount(lengths, budget)
}
```

The `*Quantum` fields are the anti-thrash mechanism: without them, a request 1 byte over budget
would offload exactly one image, retry, fail again, offload one more… `byteQuantum`/`countQuantum`
make each retry a deterministic *step*, so recovery terminates quickly. DeepSeek's defaults
(`packages/llm/llm-deepseek/src/defaults.ts`):

```ts
/** Default bound on accumulated base64 image payload after Files API fallback. */
export const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Deterministic raw-byte removal step. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
/** Deterministic base64-byte removal step after Files API fallback. */
export const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Deterministic image-count removal step. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
```

pi-ai's bound is `DEFAULT_REQUEST_IMAGE_MAX_BYTES` on the base64 representation
(`packages/llm/llm-pi-ai/src/config.ts`), with per-request-version caps
`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048` and
`DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024`.

**The offload is a durable, append-only decision — not a mutation.** This is the single most
important modelling choice. `packages/compaction/compaction-image-offload/src/projection.ts`:

```ts
/** Exact input-image occurrences selected by one durable offload decision. */
export interface ImageOffloadTarget {
  /** Current message-producing event containing these occurrences. */
  seq: SessionSeq
  /** Zero-based depth-first image indexes within the immutable message. */
  imageIndexes: number[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Permanently omit selected input-image occurrences from subsequent model requests.
     * Targets name unique current user/message or tool/result nodes. Nonempty, strictly
     * increasing indexes count all images in depth-first order, including nested tool
     * results and already omitted images. Message nodes and identities remain unchanged.
     * @messageProjection
     */
    'image/offload': { targets: ImageOffloadTarget[] }
  }
}
```

The event names `(seq, imageIndexes[])` — *indices*, not ids — so the same attachment can be
retained in one place and omitted in another. The projection is a **pure replay function**:

```ts
/** Immutable application of the image occurrences recorded by image/offload. */
export function offloadMessageImages(message: Message, indexes: readonly number[]): Message {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks: readonly ContentBlock[]): ContentBlock[] => {
    let next: ContentBlock[] | undefined
    for (const [index, block] of blocks.entries()) {
      let projected = block
      if (block.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
          projected = { ...block, offloaded: true }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, index)
      next?.push(projected)
    }
    return next ?? blocks as ContentBlock[]
  }
  const content = visit(message.content)
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  return deepFreeze({ ...message, content })
}
```

And the executor, `packages/compaction/compaction-image-offload/src/index.ts` — verbatim:

```ts
export function apply(ctx: Context): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  ctx.on('agent/request-error', ({ agent, failure }, next): Promise<RequestErrorAction> => {
    if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === undefined) return next()
    // A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event.
    if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next()
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }, next) => {
    if (!(error instanceof LlmError)
      || error.code !== IMAGE_OFFLOAD_REQUIRED_CODE
      || error.failure.offloadImages === undefined) return next()
    signal?.throwIfAborted()
    if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next()
    return true
  })
}
```

Selection walks the surface in model-request order and skips assistant nodes:

```ts
export function offloadOldestImages(session: Session, sourceEventSeqs: readonly SessionSeq[], count: number): boolean {
  const targets: ImageOffloadTarget[] = []
  for (const seq of sourceEventSeqs) {
    if (count === 0) break
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)!
    const imageIndexes: number[] = []
    let imageIndex = 0
    const visit = (blocks: readonly ContentBlock[]): void => {
      for (const block of blocks) {
        if (count === 0) break
        if (block.type === 'image') {
          if (block.offloaded !== true) {
            imageIndexes.push(imageIndex)
            count -= 1
          }
          imageIndex += 1
        }
      }
    }
    visit(message.content)
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  if (targets.length === 0) return false
  session.append('image/offload', { targets })
  return true
}
```

### 4.4 The three placeholders (what the model actually reads instead)

`packages/llm/llm/src/content.ts:104-124` — verbatim:

```ts
/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @param access - optional provider-resolved path for model tools.
 * @returns identity, normalized metadata, and the available recovery path.
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}
```

and `content.ts:80-83`:

```ts
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}
```

and the third, for a *retained* image on a vision route (`content.ts:92-105`), which is
prepended beside the real image part:

```ts
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}
```

with

```ts
function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}
```

So a vision route gets **both** the image part **and** a text handle naming the read-only
normalized path, and can recover an offloaded image by reading that path. Offloaded images
never come back automatically (documented limitation).

### 4.5 Host → browser byte retrieval

There is **no `<img src="/api/...">` for session images.** The path is:

1. Client calls `session.readAttachment(attachmentId)`
   (`packages/api/session-controller/src/client/contract/session.ts:93-100`):

```ts
  /**
   * Resolve one durable image referenced by this session.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
```

2. That issues the `session.attachment` RPC
   (`packages/api/session-controller/src/client/sessions/session.ts:318-333`):

```ts
  /**
   * Resolve one image referenced by this session into browser-consumable bytes.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    const result = await this.remote.session.attachment({
      sessionId: this.sessionId,
      attachmentId,
    })
    if (!result.ok) return result
    const binary = atob(result.value.data)
    const data = Uint8Array.from(binary, char => char.charCodeAt(0))
    return { ok: true, value: { attachment: result.value.attachment, data } }
  }
```

3. The host authorizes by **walking the session log for a matching reference** and only then
   reads the object (`packages/api/session-controller/src/commands.ts:391-425`):

```ts
  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    …
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      …
    }
  }
```

with

```ts
function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}
```

`imageInEvent` (`commands.ts:632-680`) walks `user/message`, `tool/result`,
`team/message/queued`, `agent/inbox/spliced`, `compaction/summary`, `assistant/message`, and
assistant stream `block-end` chunks.

**The authorization model is: "referenced by this session".** There is no per-image ACL, no
signed URL, no expiry. The session id *is* the capability. Response value type
(`packages/api/session-controller/src/types.ts:349-358`):

```ts
/** Durable image read request. */
export interface SessionAttachmentRequest {
  readonly sessionId: SessionId
  readonly attachmentId: AttachmentIdType
}

/** Durable image read response value. */
export interface SessionAttachmentValue {
  readonly attachment: ImageAttachmentRef
  readonly data: string
}
```

Note `data: string` — base64 over the RPC.

4. The client turns bytes into a browser URL and caches it per session, in
   `packages/client/ui-conversation/src/client/conversation/historical-images.ts`:

```ts
  private loadCanonical(
    key: string,
    entry: ImageUrlEntry,
    attachment: ImageAttachmentRef,
  ): Promise<string> {
    return entry.binding.session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        this.assertLive(key, entry)
        let url: string
        if (typeof URL.createObjectURL !== 'function') {
          url = `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        } else {
          const bytes = Uint8Array.from(result.value.data)
          url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        }
        this.assertLive(key, entry)
        this.urls.add(url)
        const previous = entry.current
        entry.current = url
        if (previous !== undefined && previous !== url) this.releaseUrl(previous)
        return url
      })
      .catch(…)
  }
```

Keyed by `attachment.attachmentId`, deduped per session, with `URL.revokeObjectURL` on
session-binding release and strict liveness assertions that throw if the scope died mid-read.
`peek()` gives a synchronous cached URL so a re-render does not flash a placeholder.
`seed()` adopts the composer's own object URL immediately and swaps in the canonical one when
the durable read completes — that is how the optimistic submission echo shows the image with
**zero** extra latency.

There is also a separate `/api/file` GET/HEAD route for *workspace* files
(`packages/api/session-controller/src/media-references.ts`), but it serves by absolute path
from `ctx.fs` with `Cache-Control: private, no-store`, and is **not** used for session
attachments. Don't conflate the two.

### 4.6 The client `useResource` model — and why images do *not* use it

`packages/client/resources` implements a general protocol-keyed address→value model:

```ts
/**
 * The one URL scheme resource addresses use: `dsh-resource://<type>/…`, where
 * the host names the protocol. Other schemes (`sidebar://…`) are navigation
 * addresses and name no resource.
 */
export const RESOURCE_SCHEME = 'dsh-resource'
```

with `UseResource` returning a four-state snapshot:

```ts
export type ResourceStatus = 'none' | 'loading' | 'live' | 'failed'

/** One address's current state, as `useResource` returns it. */
export interface ResourceSnapshot<Value> {
  readonly status: ResourceStatus
  /** The latest `ok` frame's value; kept through a later failure frame, absent before the first. */
  readonly value: Value | undefined
  /** The latest frame's failure; present only while `status` is `failed`. */
  readonly failure: RemoteFailure | undefined
}
```

**Grep result, and this is the answer to your §4 question:** `ResourceProtocolMap`
(`packages/client/ui-slots/src/index.ts:47`, `export interface ResourceProtocolMap {}`) is
augmented by only **three** modules on master — `packages/api/workspace-files/src/client/types.ts`,
`packages/client/ui-plan/src/client/plan-resource.ts`, and the package's own tests. **There is
no `image` protocol.** Images deliberately bypass `useResource` and use the direct
`loadImage` callback threaded through slot props:

```ts
/** Durable image loader with an optional synchronous cache read. */
export type MessageImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined
}
```

wired in `packages/client/ui-chat/src/client/apply.ts:237-240`:

```ts
          loadImage: Object.assign(
            (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
            { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
          ),
```

**Flag as a judgement call, not a fact:** the resource model is a plausible alternative
transport (you could register a `dsh-resource://image/<sessionId>/<attachmentId>` provider and
get frame-streaming and refcounting for free), but master does not do it. The likely reasons:
the loads are one-shot (no live updates), the dedupe/`peek` needs are different, and the
byte payload wants a blob URL rather than a snapshot store. If you reimplement, the
`loadImage`-callback shape is the lower-risk choice.

### 4.7 Byte-size caps: summary and failure modes

| Layer | Cap | On exceed |
|---|---|---|
| Browser file / drop | `maxImagesPerMessage` 20, `maxMessageImageBytes` 200 MiB, `maxImageBytes` 20 MiB, `maxImagePixels` 64 MP, `maxImageDimension` 8192 | `AttachmentError` → host rejects prompt with `details.reason`; client shows localized copy via `attachmentErrorText` |
| Stored normalized image | 4 MP total pixels, 8192 px long edge, 4 MiB encoded | downscaled silently; `originalDimensions` records the original |
| `read_image` input | `min(maxImageBytes, maxMessageImageBytes)` | recoverable tool error with downscale advice |
| DeepSeek request (Files/raw) | `maxRequestFilesBytes`, `maxImagesPerRequest` | `IMAGE_OFFLOAD_REQUIRED` + `offloadImages` count |
| DeepSeek request (inline base64 fallback) | `DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES` = 20 MiB | same |
| pi-ai request | `maxRequestImageBytes` (default from `DEFAULT_REQUEST_IMAGE_MAX_BYTES`), representation `base64` | same |
| Wire transport | `attachments.imageLimits.maxMessageImageBytes * 4 / 3` (`packages/client/connection/src/index.ts:78`) | request body refused |

Client-side copy maps the reason codes to specific messages
(`packages/client/ui-conversation/src/client/image-labels.ts`), e.g.
`IMAGE_TOO_MANY_PIXELS → image.tooManyPixels`, `TOO_MANY_IMAGES → image.tooMany`,
`IMAGE_TOO_LARGE → image.fileTooLarge`, `IMAGES_TOO_LARGE → image.totalTooLarge`,
`MODEL_DOES_NOT_SUPPORT_IMAGES → image.modelUnsupported`, and anything else folds into one
generic `image.sendFailed` line carrying the raw reason code for a bug report.

---

## 5. Rendering

### 5.1 The component

`packages/client/ui-attachment/src/MessageImage.tsx`. The public surface:

```tsx
/** Loads a session-authorized durable image URL and may expose a cached URL synchronously. */
export type ImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined
}

/** One gallery entry: a durable admitted reference, or a submission echo's local preview. */
export type MessageImageSpec =
  | {
    readonly attachment: ImageAttachmentRef
    /** Presentation-only name for the thumbnail and lightbox; loading uses the original reference. */
    readonly label?: string
  }
  | {
    readonly preview: {
      readonly url: string
      readonly name?: string
      readonly width?: number
      readonly height?: number
    }
  }
```

The **load lifecycle** — note it is *immediate on mount*, with a retry counter, and no
observer:

```tsx
  const preview = 'preview' in image ? image.preview : undefined
  const attachment = 'attachment' in image ? image.attachment : undefined
  const [loaded, setLoaded] = useState<string | null>(() =>
    attachment === undefined ? null : (load.peek?.(attachment) ?? null))
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  // Retry re-arms the one load effect below, so every attempt — first load or
  // retry — runs under the same liveness guard and the same reset.
  const [attempt, setAttempt] = useState(0)
  const request = useCallback(() => { setAttempt(a => a + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])
  const dimensions = useMemo(() => dimensionsOf(image), [image])
  const fit = useMemo(
    () => {
      if (variant !== 'single') return undefined
      // A preview whose intake probe has not resolved sizes as a square crop;
      // the durable replacement restores the exact fit.
      return dimensions === undefined
        ? { width: 240, height: 240, objectPosition: 'center' }
        : singleFit(dimensions)
    },
    [dimensions, variant],
  )

  useEffect(() => {
    if (attachment === undefined) return
    let live = true
    setError(false)
    setLoaded(load.peek?.(attachment) ?? null)
    void load(attachment).then((url) => { if (live) setLoaded(url) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load, attempt])
```

**Sizing** — the DeepSeek Chat rule, with an explicit rationale:

```tsx
/** Display box for a lone image (DeepSeek Chat rule): long edge 240px with
 * the rendered aspect ratio clamped to [0.25, 4] — the overflow is cropped by
 * `object-fit: cover` — and never upscaled past the image's natural size. The
 * crop anchor keeps the top of very tall images and the left of very wide
 * ones, where the informative content usually starts. */
function singleFit(
  dimensions: { readonly width: number; readonly height: number },
): { width: number; height: number; objectPosition: string } {
  const natural = dimensions.width / dimensions.height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, dimensions.width / box.width, dimensions.height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}
```

`dimensionsOf` reads `attachment.width`/`height` directly off the durable reference — the
reference carries display dimensions so the box can be reserved before a single byte arrives
(no layout shift), and no probe round-trip is needed for the durable arm.

**States and variants** — verbatim:

```tsx
  const src = preview?.url ?? loaded
  const label = ('attachment' in image ? image.label : undefined)
    ?? preview?.name ?? attachment?.name ?? labels.image
  const loadingThumbnail = variant === 'thumbnail' && src === null
  if (error) return (
    <button
      type="button"
      className={css.error}
      data-variant={variant}
      title={variant === 'thumbnail' ? labels.loadFailed : undefined}
      aria-label={variant === 'thumbnail' ? labels.loadFailed : undefined}
      onClick={request}
    >
      {variant === 'thumbnail'
        ? <span aria-hidden="true"><IconRefreshOutlineRegular /></span>
        : labels.loadFailed}
    </button>
  )
  return (
    <>
      <button
        type="button"
        className={css.frame}
        data-variant={variant}
        style={fit === undefined ? undefined : { width: fit.width, height: fit.height }}
        title={loadingThumbnail ? labels.loading : labels.open}
        aria-label={loadingThumbnail ? labels.loading : labels.openNamed(label)}
        aria-busy={loadingThumbnail || undefined}
        onClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null
          ? (
            <span className={css.loading} aria-hidden={loadingThumbnail || undefined}>
              {loadingThumbnail ? <IconLoadingOutlineRegular className={css.spinner} /> : labels.loading}
            </span>
          )
          : <img src={src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} />}
      </button>
      {open && src !== null && <ImageLightbox src={src} alt={label} labels={labels.lightbox} onClose={close} />}
    </>
  )
```

**Gallery variant selection** (verbatim):

```tsx
export function ImageGallery({ images, load, align, compact = false, thumbnail = false, labels }: {
  images: readonly MessageImageSpec[]
  load: ImageLoader
  align: 'start' | 'end'
  compact?: boolean
  thumbnail?: boolean
  labels: MessageImageLabels
}) {
  if (images.length === 0) return null
  const variant = thumbnail ? 'thumbnail' : compact || images.length > 1 ? 'tile' : 'single'
```

Three variants, from `MessageImage.module.css`: `single` (JS-computed `singleFit` box),
`tile` (fixed `64px × 64px`, `object-fit: cover`), `thumbnail` (fixed `48px × 48px`,
uncropped, spinner while loading). Every variant is a `<button>` with `cursor: zoom-in`,
`min-width/min-height: 44px` (touch target), and `border-radius: var(--dsw-radius-xl)`.

**Loading placeholder:** text `labels.loading` for `single`/`tile`; a spinner icon for
`thumbnail`. **Error:** a retry button — icon-only for `thumbnail`, text `labels.loadFailed`
otherwise — whose click bumps `attempt` and re-runs the same effect. A failed `tile` keeps
its 64px cell (`MessageImage.module.css`).

**Note there is no `loading="lazy"` on this `<img>`.** The load is eager on mount. If an
image sits inside a collapsed body it does not load until the body expands, because the
component is not mounted — that collapse is the de-facto lazy mechanism. (See §5.4 for the
Markdown path, which *does* set `loading="lazy"`.)

### 5.2 The lightbox

`packages/client/ui-primitives/src/ImageLightbox.tsx` — verbatim core:

```tsx
export function ImageLightbox({ src, alt, labels, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={css.image} src={src} alt={alt} />
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutlineRegular size={16} />
      </button>
    </div>,
    document.body,
  )
}
```

Behaviours to copy: **body portal** (documented reason — an opener inside a transformed or
filtered ancestor would trap the fixed backdrop in that ancestor's box), Escape/backdrop/close
dismissal, focus trap on Tab, focus restore on unmount, `aria-modal`, and
`event.stopPropagation()` on Escape so an underlying panel does not also handle it.

There is **no pinch-zoom, pan, or rotate** — the lightbox is a full-viewport `<img>` plus the
dismiss controls.

### 5.3 Passive preview for Markdown links

`packages/client/ui-primitives/src/ImagePreview.tsx` is a *different*, deliberately inert
component: "Render an image without introducing a second activation target."

```tsx
  return <span className={css.frame}>
    {state !== 'failed' && <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      className={css.image} data-ready={state === 'ready' || undefined}
      onLoad={() => { setState('ready') }} onError={() => { setState('failed') }} />}
    {state !== 'ready' && <span className={css.status} role="status">
      {state === 'loading' && <IconLoadingOutlineRegular size={16} />}
      <span>{state === 'loading' ? loadingLabel : failedLabel}</span>
    </span>}
  </span>
```

This one is `loading="lazy"` + `decoding="async"` + `referrerPolicy="no-referrer"` — the right
default for prose-embedded images. `key={src}` on the wrapper forces a fresh state machine per
source. Note the failure state **removes the `<img>`**. Companion files:
`markdown/local-image-syntax.ts` (a `![[alt|url]]` obsidian-ish syntax rewriting the mdast
node into a standard image node), and the desktop fix `7f0a53dfb3 fix(desktop): render local
Markdown images`.

### 5.4 Inline in the transcript, or behind a collapse?

Both, by location:

- **User-message images** — always inline, never collapsed. `MessageItem.tsx` splits content
  with `contentParts(content)` into `{text, attachments, rest}`, then renders the attachment
  row *above* the text bubble:

```tsx
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({
                    images: [attachment.image],
                    align: 'end',
                    compact: compactImages,
                  })}
                </Fragment>
              )
```

with `const compactImages = attachments.length > 1` — a lone image gets `single` sizing, a
multi-image message gets `tile`s.

- **`read_image` tool results** — behind a **collapsed-by-default** disclosure. This is
  explicit in the row header comment (§3.8): "the image renders through the Tool-owned
  `tool.call.images` slot inside the collapsed-by-default expanded body". `ToolRow.tsx:160-169`
  selects the card body and `ToolRow.tsx:281-288` draws it:

```tsx
                  <div className={css.imageBody}>
                    <div className={css.imageLabel}>{imageBody.label}</div>
                    {renderSlot !== undefined && loadImage !== undefined && renderSlot('tool.call.images', {
                      images: imageBody.images,
                      loadImage,
                      align: 'start',
                    })}
                    <div className={css.imageMeta}>{imageBody.text}</div>
```

So a tool image costs one collapsed row until the user expands it — which is exactly why
mount-time-only loading is acceptable there.

### 5.5 The `imageCardModel` — the client-side narrowing you must not skip

`packages/client/ui-tool/src/client/tool/models/image-card-model.ts` is the bridge from a
settled tool result to renderable references, and it is written for **untrusted replay data**:

```ts
/**
 * The image-card material one settled call contributes: the display label plus
 * the durable references the attachment slot renders as a gallery.
 *
 * The bytes are not here. `attachmentId` is opaque and provider-owned, so a UI
 * resolves it to a session-authorized URL at render time; this model never parses
 * it nor derives a path from it.
 */
export interface ImageCardModel {
  /** Card label: the read path, shortened the way every other card's is. */
  label: string
  /** The durable images this result returned, in result order. */
  images: readonly { readonly attachment: ImageAttachmentRef }[]
  /**
   * The model-facing envelope text, for the line under the gallery.
   *
   * Taken from the result's own text block rather than the row's flattened
   * result text: an image read's content is `[text envelope, image block]`, and
   * flattening JSON.stringifies the image block, which would print the raw
   * attachment object under the picture — the symptom this card exists to remove.
   */
  text: string
}
```

Three rules stated verbatim in that file that a port should carry over:

1. **Every field arrives unvalidated on replay** ("an obsolete or hand-edited log reaches
   here"), so any mismatch **declines to the generic card rather than throwing**:
   `if (typeof part !== 'object' || part === null) continue`.
2. **Content is the single source of truth for references** — never `presentationMeta`,
   because a `tools/post-execute` hook that replaces content would leave a stale copy.
3. **The id is checked for existence only** — pattern-matching the local content-address form
   "would reject a legitimate id minted by an alternative store".

There is also a deliberately hand-written mirror of the media-type union with a warning:

```ts
/** The media types a durable image block may claim; anything else declines.
 *  Hand-written mirror of `ImageMediaType` from dsh-attachment — the wire
 *  boundary needs a runtime check and feature plugins must not import values
 *  from each other; a new member added there must be added here too, or the
 *  decline point below silently degrades that image to the generic card. */
const IMAGE_MEDIA_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])
```

### 5.6 Plugin seams

Rendering is slot-based so the tool layer never imports the attachment layer:

- `conversation.message.images` — `{kind: 'single', scope: 'session'}`, registered by
  `packages/client/ui-attachment/src/client/index.ts:20`; owner props are
  `MessageImagesOwnerProps` (`images`, `loadImage`, `align`, `compact?`, `thumbnail?`).
- `tool.call.images` — declared as a **child** of the `tool.call.toolview` entry so only
  `read_image`'s registrant may dispatch it (`read-image-row.tsx`).
- `renderMessageImages(owner)` is the closure-free dispatch helper threaded to chat nodes
  (`packages/client/ui-chat/src/client/chat/ChatView.tsx:210`).

The point of the seam: `ui-chat` and `ui-tool` contain **zero** knowledge of attachment ids,
blob URLs, or byte fetching; they pass references plus a loader and a slot renders them.

### 5.7 Composer-side thumbnails

`packages/client/ui-attachment/src/client/ComposerAttachments.tsx` uses the *browser's own*
object URL for the draft thumbnail — no round trip:

```tsx
              return (
                <div className={css.imageItem}>
                  <button
                    type="button"
                    className={css.thumbnail}
                    title={t('image.openOriginal')}
                    onClick={() => { setPreview(attachment) }}
                  >
                    <img src={attachment.previewUrl} alt={attachment.file.name || t('image.pending')} />
                  </button>
                  <button
                    type="button"
                    className={css.remove}
                    aria-label={t('image.remove', { name: attachment.file.name })}
                    onClick={() => { onRemoveAttachment(attachment.id) }}
                  >
                    <IconCloseFillRegular size={12} />
                  </button>
                </div>
              )
```

and the same `ImageLightbox` opens the local preview.

---

## 6. Model-facing side vs UI side

### 6.1 The model sees a real image, not a description

For a vision route, the provider request contains a genuine multimodal part. pi-ai
(`packages/llm/llm-pi-ai/src/context.ts:66-95`) — verbatim:

```ts
function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): string | (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}
```

Note the **text-collapse optimization**: if every resulting part is text, it degrades to a
plain string instead of a one-element array — some providers reject a text-only array.

DeepSeek (`packages/llm/llm-deepseek/src/serialize.ts:62-80`) — verbatim:

```ts
  const input = (blocks: readonly ContentBlock[]): WireInput[] => blocks.flatMap((block): WireInput[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'reasoning' || block.type === 'tool-call') return []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    const version = images.get(block.attachment.attachmentId)
    if (version === undefined) throw new LlmError('DeepSeek Messages request image is missing', 'INVALID_REQUEST')
    const fileId = fileIds?.get(block.attachment.attachmentId)
    if (fileIds !== undefined && fileId === undefined) throw new LlmError('DeepSeek Messages request file id is missing', 'INVALID_REQUEST')
    return [
      { type: 'text', text: requestImageHandleText(block.attachment, version, access(block.attachment)) },
      fileId === undefined
        ? { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
        : { type: 'image', source: { type: 'file', file_id: fileId } },
    ]
  })
```

with the wire union (`packages/llm/llm-deepseek/src/wire-types.ts:6`):

```ts
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
```

**Two request representations.** DeepSeek prefers the Files API (upload once, send
`{type:'file', file_id}`) and falls back to inline base64; `images.ts` computes the budget
differently for each (`bounds(connection, 'raw' | 'base64')`) and `inlineImages()` re-checks
the inline budget after the fallback. pi-ai has only base64.

### 6.2 Request versions are derived, not the stored bytes

An `ImageAttachmentRef` is the *normalized durable* image; what gets sent is a **request
version** re-encoded per route:

```ts
/** Cached request version derived from one provider-independent normalized attachment. */
export interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}

/** Deterministic request-image target selected by one exact model route for one attachment. */
export interface ImageRequestTarget {
  /** Target width in pixels; a target above the source keeps the source width. */
  width: number
  /** Target height in pixels; a target above the source keeps the source height. */
  height: number
  /** Encoded-byte target before base64 expansion or Files API upload; the smallest quality-ladder output is kept when no quality fits. */
  maxBytes: number
}
```

Defaults: DeepSeek `DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET`, `REQUEST_IMAGE_MAX_DIMENSION`,
`resolveRequestImageTarget`; pi-ai `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048`,
`DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024`. `depth: 'uchar'` and `space: 'srgb'` are
*proven* post-encode facts, not declarations — 16-bit PNGs are converted at admission, and an
unconvertible one is a documented refusal.

Token accounting is a faithful port of DeepSeek's published calculator
(`packages/llm/llm-deepseek/src/image-tokens.ts`): 14px patches, 3:1 per-axis downsample,
`MAX_IMAGE_TOKENS = 1024`, `MIN_PIXELS = 544 * 544`, and `gridTokens = h * (w + 1) + 2`. Worth
knowing that image cost is modelled rather than guessed.

### 6.3 Non-vision model handling — three distinct behaviours

**(a) Text-only route → deterministic placeholder, logged content untouched.**
`packages/llm/llm/src/content.ts:335-360`:

```ts
/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project request image content into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[]
```

Renderable form: `[image omitted because this model accepts text only; attachment sha256:1a2b3c4d]`.
`images` is a *projection* — the durable message keeps its image block, so switching to a
vision model restores the image.

**(b) Capability gating on the way in.** DeepSeek's `prepareImages` refuses if the model does
not claim image input (`packages/llm/llm-deepseek/src/images.ts:50-56`):

```ts
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true || attachments === undefined) {
    throw new LlmError('DeepSeek Messages image input requires a vision model and attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some(message => message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content))) {
    throw new LlmError('DeepSeek Messages supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
```

That second check is the adapter-level restatement of §1.3: images in a `system`, `developer`,
or `assistant` message are a hard error.

**(c) Pre-flight rejection with a user-facing reason.** The host rejects the *prompt* with
`MODEL_DOES_NOT_SUPPORT_IMAGES` before admitting bytes
(`packages/api/session-controller/src/commands.ts:342`), which the client renders as
`image.modelUnsupported`. So a user attaching an image to a text-only model is told
immediately, rather than after a wasted upload.

Capability itself is declared per model as `inputModalities?: ModelModality[]`
(`packages/llm/llm-deepseek/src/types.ts`, "Accepted request modalities; omission is
text-only"), mirrored for pi-ai as `input`; there is a settings UI for it
(`packages/client/ui-settings-models`, "Input types" with Text/Image checkboxes). Docs:
`docs/user/guide/providers.md:75` — "DeepSeek treats an omitted `inputModalities` as text-only
and rejects an empty list."

### 6.4 The named commits

**`4f1eb8f3ac`** — merge of PR #2724, `feat(llm-deepseek): support native multimodal
requests`. Diff vs first parent: 51 files, +1432/-247. Substantive changes:

- `packages/llm/llm-deepseek/src/serialize.ts` (+233) — the image arm of `input()` quoted in §6.1.
- `packages/llm/llm-deepseek/src/adapter.ts` (+52), `index.ts` (+35), `types.ts` (+19) — wiring
  `resolveAttachments` / `resolveImageAccess` and the request-local image budgets.
- `packages/llm/llm-pi-ai/src/context.ts` (**net -98**) — pi-ai's image conversion was
  *refactored onto the shared LLM helpers* rather than keeping its own copy.
- `packages/llm/llm/src/content.ts` (+78) + `tests/content.spec.ts` (+89) — the shared
  placeholder/projection helpers (`offloadedImageText`, `requestImageHandleText`,
  `projectOffloadedImages`, `requiredImageOffload`) that both adapters now call.

So the architectural outcome of this commit is: **provider-neutral image policy lives in
`dsh-llm`; adapters only serialize.**

**`e637bcfb98`** — merge of PR #2726, `feat(llm-deepseek): publish the vision model`. Diff vs
first parent: 24 files, +154/-65. Mostly catalog and docs: `packages/llm/llm-deepseek/src/index.ts`
(+8) publishes the vision model with `inputModalities` including `image`, the
`adapter.e2e.ts` gains a live vision round trip (+69), and the `examples/acp-agent/*` image
compositions are updated. On the same date the note
`.agents/notes/archived/.../2026-08-19-direct-deepseek-vision-input.md` was written.

**Related and worth knowing:** `f2beb99c3b` `feat(llm): remove the V4 Flash and V4 Flash Vision
Exp defaults` — deletes 12 lines from `packages/llm/llm-deepseek/src/common/models.ts`. dsh
**deliberately has no hard-coded vision model**; capability is deployment configuration.
`3df6f92d03` `feat(web): configure model image input in settings` adds the checkbox UI.
`82 404a7b6` `test(llm): retain unsupported-image coverage after catalog upgrade` guards the
refusal path.

---

## 7. Composer-side attachment flow

### 7.1 Stage 1 — intake into a browser-only draft

Images and files diverge immediately. `packages/client/ui-conversation/src/client/service.ts:73-118`:

```ts
/** Create one browser-only image draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerImageAttachment {
  return {
    kind: 'image',
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

/**
 * Fill the draft's intrinsic dimensions once the browser parses the image
 * header (a metadata read off the preview URL, not a full decode). Failures
 * and non-browser runtimes leave them absent — consumers size those images
 * from CSS constraints instead. The descriptors stay registry-owned; submit
 * reads the dimensions into an immutable echo snapshot, so this late write
 * does not require a store notification.
 */
function probeDimensions(attachment: ComposerImageAttachment): void {
  if (typeof Image !== 'function') return
  const probe = new Image()
  probe.onload = () => {
    attachment.width = probe.naturalWidth
    attachment.height = probe.naturalHeight
  }
  probe.src = attachment.previewUrl
}
```

Three notable decisions:

- **Images are held in browser memory, not uploaded at intake.** The bytes go out with the
  prompt. Files (non-images) upload *immediately* in the background over
  `/api/session/uploadFileBinary` (`packages/client/file-upload/src/protocol.ts`:
  `export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'`) and are referenced by
  `receiptId`.
- **Only the id enters input state** (`InputState.attachmentIds: readonly DraftAttachmentId[]`,
  `contract/input.ts`); the `File` and object URL stay in the controller. That keeps the input
  store serializable and cheap.
- **Dimensions are probed off the object URL** (header read, not a decode) and written directly
  onto the descriptor. The submit path reads them into an immutable echo snapshot, which is why
  the late write needs no store notification.

### 7.2 Stage 2 — the optimistic echo

`packages/api/session-controller/src/client/contract/snapshot.ts:8-40`:

```ts
/** One image displayed by a local submission echo before durable admission. */
export interface PendingSubmissionImage {
  /** Browser-owned preview URL; its lifecycle belongs to the submitter, never this snapshot. */
  readonly previewUrl: string
  /** Browser file name, when the file had one. */
  readonly name?: string
  /** Intrinsic pixel width, when the submitter has probed it. */
  readonly width?: number
  /** Intrinsic pixel height, when the submitter has probed it. */
  readonly height?: number
}
```

```ts
/**
 * One local prompt-submission echo: inserted synchronously when a submission
 * begins, so the conversation can show the message before serialization,
 * transport, and durable admission complete. Client-memory only — reload and
 * reconnect rebuild the conversation from durable events alone.
 */
```

**This is the single best UX idea in the flow:** the message with its picture appears
*instantly* using the local object URL, and is later reconciled with the durable event. On
resolution, `seedImageUrl` hands that same URL to the historical cache so the picture never
re-renders or flashes.

### 7.3 Stage 3 — submit

`service.ts:229-296`. Order of operations (verbatim):

```ts
    const pendingAttachments = attachments.map(attachment => attachment.kind === 'image'
      ? {
        type: 'image' as const,
        value: {
          previewUrl: attachment.previewUrl,
          ...(attachment.file.name === '' ? {} : { name: attachment.file.name }),
          ...(attachment.width === undefined ? {} : { width: attachment.width }),
          ...(attachment.height === undefined ? {} : { height: attachment.height }),
        },
      }
      : { type: 'file' as const, value: uploadFor(attachment).file })
    const serializeAttachments = (): Promise<Parameters<SessionFace['prompt']>[0]> => Promise.all(
      attachments.map(async attachment => attachment.kind === 'image'
        ? { type: 'image' as const, ...await this.encodeImage(attachment.file) }
        : { type: 'file' as const, receiptId: uploadFor(attachment).receiptId }),
    )
```

then

```ts
    let content: Parameters<SessionFace['prompt']>[0]
    try {
      await nextPaint()
      const uploaded = await serializeAttachments()
      content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
    } catch (error) {
      submission.abandon()
      throw error
    }
    const result = await session.prompt(content, mode, signal, submission.requestId)
    if (!result.ok) return { kind: 'error' }
    if (retirement !== undefined && (await retirement).reason !== 'observed') return { kind: 'error' }
    return { kind: 'success' }
```

Details worth copying:

- **`await nextPaint()` before serialization** — "give the echo one paint opportunity without
  letting a throttled frame clock block admission". The local preview must actually paint
  before the base64 encode occupies the main thread.
- **Attachment parts precede the text part** in the content array.
- **`beginSubmission({requestId})` / `abandon()` / retirement**: an identified submission
  retires its own echo if it fails; a successful one waits for the durable event to be
  *observed* (`reason === 'observed'`) before reporting success, so the transcript never ends
  up with neither an echo nor a durable message.
- **Images are encoded lazily at submit**, in parallel over the attachment list.

### 7.4 The durable session event

The admitted prompt becomes a normal `user/message` whose content has the reference form from
§2.1 (`AdmittedPromptContentPart`). Nothing image-specific is added to the event. Reading the
log of a real session, a user image message looks exactly like:

```json
{"type":"user/message","data":{"content":[
  {"type":"image","attachment":{"attachmentId":"sha256:…","mediaType":"image/png","bytes":123456,"width":1024,"height":768,"name":"shot.png"}},
  {"type":"text","text":"what is wrong here?"}
],"source":{"kind":"user"},"role":"user","id":"{{message:N}}"},"surfaceOp":"append"}
```

### 7.5 Validation on the client, before the round trip

`attachmentErrorText` (`packages/client/ui-conversation/src/client/image-labels.ts`) maps the
host's `details.reason` to specific copy — the reason union is effectively the error
vocabulary of the whole image pipeline:

`MODEL_DOES_NOT_SUPPORT_IMAGES`, `FILE_NOT_STAGED`, `IMAGE_TOO_MANY_PIXELS`,
`IMAGE_DIMENSION_TOO_LARGE`, `INVALID_IMAGE`, `IMAGE_TYPE_MISMATCH`, `TOO_MANY_IMAGES`,
`IMAGE_TOO_LARGE`, `IMAGES_TOO_LARGE`, and a default `image.sendFailed {reason}`.

Note the deliberate split: reasons the *user can act on* name the limit and the way out;
reasons they cannot fold into one generic failure line carrying the code for a bug report.

---

## 8. What I would port, in order

1. **The reference type.** `{attachmentId, mediaType, bytes, width, height, name?,
   originalDimensions?}` with an opaque id and no path. Everything else follows. The
   `width`/`height` are what let you reserve layout before bytes arrive.
2. **Bytes off-log.** Session events carry references. Store bytes content-addressed on the
   host. Never put base64 in the log — it destroys diffability and log size.
3. **Fetch by authenticated RPC, render via blob URL.** Session id is the capability;
   authorize by "is this attachment referenced by this session's log". Cache per session,
   `revokeObjectURL` on scope release, expose a synchronous `peek` for the cache hit.
4. **Tool results produce `[text, image]`.** Persist before returning, so the reference is
   durable by the time the event is appended. Keep the *reference* only in content; put only
   what content cannot carry into presentation metadata.
5. **The three states:** sent-as-image (vision route), projected-to-text (text-only route),
   offloaded (request over budget). Keep #2 and #3 as *projections* so they are reversible and
   replayable; only #3 is a durable logged decision.
6. **Optimistic local preview** for the composer, reconciled by seeding the cache — the
   perceived-latency win is large and costs one `seed()` method.
7. **Render defensively.** Validate every field of a replayed block; degrade to a generic
   card, never throw; never parse the attachment id.

### Things I would *not* port

- The merge-extensible `ContentBlockMap` declaration-merging machinery, unless your plugin
  system needs it.
- The `*Quantum` offload stepping, unless you enforce hard request-size budgets. It exists to
  make retry loops terminate in one step.
- The `image/offload` durable projection, if you are willing to have the route drop images
  locally. But be aware of the tradeoff dsh chose: *never silently drop*.

---

## 9. Uncertainty and gaps — explicit flags

1. **`read_image` commit `a631115597`** is a **merge** commit; I diffed it against its first
   parent to show what the PR brought in. If you need the individual commit rather than the
   PR, `3648331b11` is the second parent to inspect.
2. **No screenshot path exists on master.** I searched `packages/**/src/**/*.ts` for
   `screenshot` and found nothing, and `packages/computer-use/**` contains only a registry and
   driver seams with no image block production. If your tool has browser or computer-use
   screenshots, you will be designing that path from scratch — the MCP projector (§2.3) is the
   closest template.
3. **Assistant-generated images are unreachable but renderable.** The `ImageBlock` type and the
   client renderer both support it; the streaming assembler does not. I did not exhaustively
   verify that no adapter emits an image `block-end` chunk — I verified `BlockAssembler`'s
   `assemble()` has no image case and the type doc says adapters declare text-only output.
4. **`useResource` vs `loadImage`.** I state as fact that no `image` resource protocol exists
   on master (only three `ResourceProtocolMap` augmentations, none imaging). My explanation of
   *why* dsh chose the callback instead is **inference**, not documented rationale — I found no
   decision record either way.
5. **`ImageAttachmentLimits` values are defaults**, overridable per deployment via
   `attachment-local` config; and the DeepSeek/pi-ai route budgets are per-connection config.
   There is also a live settings UI. Do not treat the numbers as invariants.
6. **Rendering specs.** I read the components and CSS but did not run the app or the client
   test suites (`packages/client/ui-attachment/tests/message-image.client.spec.tsx`,
   `packages/client/ui-tool/tests/image-card.client.spec.tsx` (384 lines),
   `packages/client/ui-primitives/tests/image-lightbox.client.spec.tsx`). Those specs are the
   authoritative behavioural contract if you need more precision than the components show.
   In particular I did not verify how `MessageImage` behaves under React StrictMode double-mount
   beyond the `live` flag pattern.
7. **The `bytesToBase64` / `data:` fallback branch** in `historical-images.ts` triggers only
   when `URL.createObjectURL` is unavailable. I did not investigate which runtime that is (SSR?
   an Electron renderer config?) — flagging it as unverified.
8. **`GET /api/file`** serves workspace files by absolute path and is unrelated to session
   attachments. I mention it only to prevent a wrong port; I did not trace its full
   authorization.
9. **Markdown-embedded images** (`ImagePreview`, `local-image-syntax.ts`, the desktop fix
   `7f0a53dfb3`) are a *separate* pipeline from session images — a Markdown image is a URL
   resolved by the browser or the file resource protocol, not an `ImageAttachmentRef`. I
   covered it briefly for completeness but did not investigate its resource protocol.
