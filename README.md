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

## Install

Install the extension in SillyTavern using this Git URL:

```text
https://github.com/winter-bit-cry/SillyTavern-Claude-Cache-Anchor
```

Then apply the backend bridge from the SillyTavern root:

```bash
git apply data/default-user/extensions/Claude-Cache-Anchor/backend-patch/sillytavern-chat-completions.patch
```

If your SillyTavern profile or extension folder is different, adjust the path accordingly. Restart SillyTavern after applying the patch.

## Recommended setup

For the "only the newest 5 messages keep body text, older messages are frozen summaries" workflow, use:

- `Anchor placement`: `Before recent body window`
- `Recent body messages`: `5`
- `Cache time`: `1 hour` or `5 minutes`

This caches the prompt prefix before the newest prompt messages: preset/system prompt, character card, static world info, and frozen old summaries.
Hidden/prompt-ignored messages are skipped when counting the newest prompt messages.

Use `Last early system message` only when you want to cache stable system prompt, character card, examples, and static world info but not old summaries.

Put rolling summaries and recent chat after the anchor. If the content before the anchor changes every round, Claude will create new cache entries instead of reading the old one.

## Usage

1. Restart SillyTavern after installing the backend bridge.
2. Enable `Claude Cache Anchor` in extensions.
3. Set `Anchor placement` to `Before recent body window`.
4. Set `Recent body messages` to your body window size, such as `5`.
5. Set `Cache time` to `1 hour` or `5 minutes`.
6. Send one message to create the cache.
7. Send another message within the TTL while keeping older summaries unchanged.

The settings panel status is a best-effort preview from the current chat. The final cache anchor is applied to the generated chat-completion prompt at send time.

## Verify

Look for Anthropic usage fields in the response or logs:

- `cache_creation_input_tokens`: tokens written into cache
- `cache_read_input_tokens`: tokens read from cache
The first request should usually show creation. A later request with the same cached prefix should show reads.

## Backend bridge

This extension needs the companion local patch in `src/endpoints/backends/chat-completions.js`.

From the SillyTavern root, apply the bundled patch after installing this extension:

```bash
git apply data/default-user/extensions/Claude-Cache-Anchor/backend-patch/sillytavern-chat-completions.patch
```

If your extension is installed in another user profile or folder, adjust the path accordingly. Then restart SillyTavern.

The marker is:

```text
<!-- ST_CLAUDE_CACHE_ANCHOR -->
```

It is stripped before sending to Anthropic.
