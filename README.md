# Claude Cache Anchor

SillyTavern extension plus a tiny local backend bridge for placing Anthropic Claude `cache_control` at a semantic prompt point.

## Important limitation

SillyTavern third-party extensions run in the browser. They can edit the prepared prompt, but they cannot directly change the final Claude API payload that the SillyTavern backend sends.

For this extension to actually add Claude `cache_control`, install the frontend extension and apply the bundled backend patch. Without the backend patch, the extension can only place an internal marker and will not enable prompt caching by itself.

## What this does

- Hooks `CHAT_COMPLETION_PROMPT_READY`.
- Adds an internal marker to the selected prompt message.
- The backend bridge removes the marker and adds Anthropic `cache_control` to that content block.
- Lets the extension settings choose Claude cache TTL: `5m` or `1h`.
- Supports a round-based window for chats stored as `user summary` + `assistant summary` pairs.

## Install

Install the extension in SillyTavern using this Git URL:

```text
https://github.com/winter-bit-cry/SillyTavern-Claude-Cache-Anchor
```

Then install the backend bridge from the SillyTavern root:

```bash
node data/default-user/extensions/SillyTavern-Claude-Cache-Anchor/backend-patch/install.mjs
```

If your SillyTavern profile or extension folder is different, adjust the path accordingly. Restart SillyTavern after installing the backend bridge.

## Recommended setup

For the "older turns are saved as user-summary / assistant-summary pairs, only newest turns keep body text" workflow, use:

- `Anchor placement`: `Before recent body rounds`
- `Recent body rounds`: the number of newest user/assistant turns to keep after the cache point
- `Cache time`: `1 hour` or `5 minutes`

This caches the prompt prefix before the newest body turns: preset/system prompt, character card, static world info, and older summary pairs.
Hidden/prompt-ignored messages are skipped when counting the newest prompt messages.

Use `Last early system message` only when you want to cache stable system prompt, character card, examples, and static world info but not old summaries.

Use `Before recent body window` only when you want to count individual prompt messages instead of user/assistant rounds.
If old summaries are rewritten inside one large summary block every round, Claude will create new cache entries instead of reading the old one. For best cache reuse, keep old summaries as append-only user/assistant summary messages.

## Usage

1. Restart SillyTavern after installing the backend bridge.
2. Enable `Claude Cache Anchor` in extensions.
3. Set `Anchor placement` to `Before recent body rounds`.
4. Set `Recent body rounds` to your body window size, such as `5`.
5. Set `Cache time` to `1 hour` or `5 minutes`.
6. Send one message to create the cache.
7. Send another message within the TTL while keeping previous summary-pair messages unchanged.

The settings panel status is a best-effort preview from the current chat. The final cache anchor is applied to the generated chat-completion prompt at send time.

## Verify

Look for Anthropic usage fields in the response or logs:

- `cache_creation_input_tokens`: tokens written into cache
- `cache_read_input_tokens`: tokens read from cache
The first request should usually show creation. A later request with the same cached prefix should show reads.

## Backend bridge

This extension needs the companion local patch in `src/endpoints/backends/chat-completions.js`.

From the SillyTavern root, run the bundled installer after installing this extension:

```bash
node data/default-user/extensions/SillyTavern-Claude-Cache-Anchor/backend-patch/install.mjs
```

If your extension is installed in another user profile or folder, adjust the path accordingly. Then restart SillyTavern.

The marker is:

```text
<!-- ST_CLAUDE_CACHE_ANCHOR -->
```

It is stripped before sending to Anthropic.
