import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PATCH_MARKER = 'ST_CLAUDE_CACHE_ANCHOR';

function findSillyTavernRoot() {
    const candidates = [
        process.cwd(),
        path.resolve(SCRIPT_DIR, '../../../../..'),
    ];

    for (const candidate of candidates) {
        const target = path.join(candidate, 'src/endpoints/backends/chat-completions.js');
        if (fs.existsSync(target)) {
            return candidate;
        }
    }

    throw new Error('Could not find SillyTavern root. Run this script from the SillyTavern root directory.');
}

function addImportAfter(text, anchor, line) {
    if (text.includes(line)) {
        return text;
    }

    if (!text.includes(anchor)) {
        throw new Error(`Could not find import anchor: ${anchor}`);
    }

    return text.replace(anchor, `${anchor}\n${line}`);
}

function addSettingsFileImport(text) {
    return text.replace(/import \{([\s\S]*?)\} from '\.\.\/\.\.\/constants\.js';/, (match, body) => {
        if (body.includes('SETTINGS_FILE')) {
            return match;
        }

        if (body.includes('VERTEX_SAFETY')) {
            return match.replace(/(\n\s*)VERTEX_SAFETY,/, '$1SETTINGS_FILE,$1VERTEX_SAFETY,');
        }

        return match.replace(/\n\} from/, '\n    SETTINGS_FILE,\n} from');
    });
}

function insertAfterLine(text, line, insertion) {
    if (text.includes(insertion.trim())) {
        return text;
    }

    const index = text.indexOf(line);
    if (index === -1) {
        throw new Error(`Could not find insertion anchor: ${line}`);
    }

    const insertAt = index + line.length;
    return `${text.slice(0, insertAt)}\n${insertion}${text.slice(insertAt)}`;
}

function replaceFirstAfter(text, startNeedle, search, replacement) {
    const start = text.indexOf(startNeedle);
    if (start === -1) {
        throw new Error(`Could not find section: ${startNeedle}`);
    }

    const index = text.indexOf(search, start);
    if (index === -1) {
        if (text.includes(replacement)) {
            return text;
        }
        throw new Error(`Could not find text to replace after ${startNeedle}: ${search}`);
    }

    return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

function ensureClaudeCacheTTL(text) {
    const start = text.indexOf('async function sendClaudeRequest');
    if (start === -1) {
        throw new Error('Could not find sendClaudeRequest.');
    }

    const requestBodyIndex = text.indexOf('const requestBody =', start);
    if (requestBodyIndex === -1) {
        throw new Error('Could not find requestBody in sendClaudeRequest.');
    }

    const beforeRequestBody = text.slice(start, requestBodyIndex);
    if (beforeRequestBody.includes('const cacheTTL = getClaudeCacheTTL(request);')) {
        return text;
    }

    const cacheTTLPattern = /const cacheTTL\s*=\s*getConfigValue\(['"]claude\.extendedTTL['"],\s*false,\s*['"]boolean['"]\)\s*\?\s*['"]1h['"]\s*:\s*['"]5m['"];\r?\n?/;
    const cacheTTLMatch = cacheTTLPattern.exec(beforeRequestBody);
    if (cacheTTLMatch) {
        const absoluteIndex = start + cacheTTLMatch.index;
        return `${text.slice(0, absoluteIndex)}const cacheTTL = getClaudeCacheTTL(request);\n${text.slice(absoluteIndex + cacheTTLMatch[0].length)}`;
    }

    const insertionAnchors = [
        /const isLimitedSampling = .*?;\r?\n/,
        /const useWebSearch = .*?;\r?\n/,
        /const useThinking = .*?;\r?\n/,
    ];

    for (const anchor of insertionAnchors) {
        const match = anchor.exec(beforeRequestBody);
        if (match) {
            const insertAt = start + match.index + match[0].length;
            return `${text.slice(0, insertAt)}        const cacheTTL = getClaudeCacheTTL(request);\n${text.slice(insertAt)}`;
        }
    }

    throw new Error('Could not find a safe place to insert cacheTTL in sendClaudeRequest.');
}

function ensureManualCacheAnchorCall(text) {
    const manualAnchorBlock = `        const hasManualCacheAnchor = applyClaudeCacheAnchor(requestBody, cacheTTL);
        if (!hasManualCacheAnchor) {
            applyClaudeCacheFallbackAtRecentWindow(requestBody, cacheTTL, getClaudeCacheRecentMessages(request));
        }
`;

    if (text.includes('const hasManualCacheAnchor = applyClaudeCacheAnchor(requestBody, cacheTTL);')) {
        if (text.includes('applyClaudeCacheFallbackAtRecentWindow(requestBody, cacheTTL, getClaudeCacheRecentMessages(request));')) {
            return text;
        }

        return text.replace(
            /        const hasManualCacheAnchor = applyClaudeCacheAnchor\(requestBody, cacheTTL\);\r?\n/,
            manualAnchorBlock,
        );
    }

    if (text.includes('const hasManualCacheAnchor = applyClaudeCacheAnchor(requestBody, cacheTTL)')) {
        return text;
    }

    const cachingAtDepthPattern = /(        if \(cachingAtDepth !== -1\) \{\r?\n\s+cachingAtDepthForClaude\(convertedPrompt\.messages, cachingAtDepth, cacheTTL\);\r?\n\s+\}\r?\n)/;
    if (cachingAtDepthPattern.test(text)) {
        return text.replace(
            cachingAtDepthPattern,
            `$1\n${manualAnchorBlock}`,
        );
    }

    const cacheHeadersPattern = /(\r?\n\s*if \(enableSystemPromptCache \|\| cachingAtDepth !== -1(?: \|\| hasManualCacheAnchor)?\) \{)/;
    if (cacheHeadersPattern.test(text)) {
        return text.replace(
            cacheHeadersPattern,
            `\n${manualAnchorBlock}$1`,
        );
    }

    throw new Error('Could not find a safe place to insert hasManualCacheAnchor.');
}

function install() {
    const root = findSillyTavernRoot();
    const target = path.join(root, 'src/endpoints/backends/chat-completions.js');
    let text = fs.readFileSync(target, 'utf8');

    if (text.includes(PATCH_MARKER)
        && text.includes('function applyClaudeCacheFallbackAtRecentWindow')
        && text.includes('applyClaudeCacheFallbackAtRecentWindow(requestBody, cacheTTL, getClaudeCacheRecentMessages(request));')) {
        console.log('[Claude Cache Anchor] Backend patch is already installed.');
        return;
    }

    text = addImportAfter(text, "import util from 'node:util';", "import fs from 'node:fs';");
    text = addImportAfter(text, "import fs from 'node:fs';", "import path from 'node:path';");
    text = addSettingsFileImport(text);

    const helperBlock = `
const ST_CLAUDE_CACHE_ANCHOR = '<!-- ST_CLAUDE_CACHE_ANCHOR -->';
const ST_CLAUDE_CACHE_RECENT_MESSAGES = 5;
const ST_CLAUDE_CACHE_DEFAULT_TTL = '1h';
const ST_CLAUDE_CACHE_TTLS = new Set(['5m', '1h']);

function normalizeClaudeCacheTTL(value, fallback = ST_CLAUDE_CACHE_DEFAULT_TTL) {
    const ttl = String(value || '').trim();
    return ST_CLAUDE_CACHE_TTLS.has(ttl) ? ttl : fallback;
}

function readClaudeCacheAnchorSettings(request) {
    try {
        const settingsPath = path.join(request.user.directories.root, SETTINGS_FILE);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return settings?.extension_settings?.claudeCacheAnchor || {};
    } catch {
        return {};
    }
}

function getClaudeCacheTTL(request) {
    const extensionTTL = readClaudeCacheAnchorSettings(request).cacheTTL;
    if (extensionTTL) {
        return normalizeClaudeCacheTTL(extensionTTL);
    }

    const configTTL = getConfigValue('claude.extendedTTL', false, 'boolean') ? '1h' : '5m';
    return normalizeClaudeCacheTTL(configTTL);
}

function getClaudeCacheRecentMessages(request) {
    const recentMessages = Number.parseInt(String(readClaudeCacheAnchorSettings(request).recentMessages ?? ''), 10);
    return Number.isInteger(recentMessages) && recentMessages > 0
        ? recentMessages
        : ST_CLAUDE_CACHE_RECENT_MESSAGES;
}

function markClaudeCacheControlOnMessage(message, cacheTTL, reason) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
        return false;
    }

    for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i];
        if (!block || block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) {
            continue;
        }

        block.cache_control = { type: 'ephemeral', ttl: cacheTTL };
        console.info(\`[Claude Cache Anchor] Applied fallback cache_control ttl=\${cacheTTL} to role=\${message.role || 'unknown'}, reason=\${reason}.\`);
        return true;
    }

    return false;
}

function applyClaudeCacheFallbackAtRecentWindow(requestBody, cacheTTL, recentMessages = ST_CLAUDE_CACHE_RECENT_MESSAGES) {
    if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
        return false;
    }

    const targetStart = requestBody.messages.length > recentMessages
        ? requestBody.messages.length - recentMessages - 1
        : requestBody.messages.length - 1;

    for (let i = targetStart; i >= 0; i--) {
        if (markClaudeCacheControlOnMessage(requestBody.messages[i], cacheTTL, \`before-last-\${recentMessages}-messages\`)) {
            console.info(\`[Claude Cache Anchor] Fallback inspected messages=\${requestBody.messages.length}, targetIndex=\${i}.\`);
            return true;
        }
    }

    console.warn(\`[Claude Cache Anchor] Fallback found no text message to mark. messages=\${requestBody.messages.length}.\`);
    return false;
}

function applyClaudeCacheAnchorToContentBlocks(blocks, cacheTTL) {
    if (!Array.isArray(blocks)) {
        return false;
    }

    let applied = false;

    for (const block of blocks) {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') {
            continue;
        }

        if (!block.text.includes(ST_CLAUDE_CACHE_ANCHOR)) {
            continue;
        }

        const originalLength = block.text.length;
        block.text = block.text.split(ST_CLAUDE_CACHE_ANCHOR).join('').trimEnd() || '\\u200b';
        block.cache_control = { type: 'ephemeral', ttl: cacheTTL };
        console.info(\`[Claude Cache Anchor] Applied cache_control ttl=\${cacheTTL} to text block, textLength=\${originalLength}.\`);
        applied = true;
    }

    return applied;
}

function applyClaudeCacheAnchor(requestBody, cacheTTL) {
    let applied = false;

    if (applyClaudeCacheAnchorToContentBlocks(requestBody.system, cacheTTL)) {
        applied = true;
    }

    if (Array.isArray(requestBody.messages)) {
        for (const message of requestBody.messages) {
            if (applyClaudeCacheAnchorToContentBlocks(message?.content, cacheTTL)) {
                applied = true;
            }
        }
    }

    return applied;
}
`;

    if (!text.includes(PATCH_MARKER)) {
        const helperAnchor = text.includes("const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';")
            ? "const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';"
            : "const API_AI21 = 'https://api.ai21.com/studio/v1';";
        text = insertAfterLine(text, helperAnchor, helperBlock);
    }

    if (text.includes(PATCH_MARKER) && !text.includes('function applyClaudeCacheFallbackAtRecentWindow')) {
        const fallbackUpgradeBlock = `const ST_CLAUDE_CACHE_RECENT_MESSAGES = 5;

function getClaudeCacheRecentMessages(request) {
    const recentMessages = Number.parseInt(String(readClaudeCacheAnchorSettings(request).recentMessages ?? ''), 10);
    return Number.isInteger(recentMessages) && recentMessages > 0
        ? recentMessages
        : ST_CLAUDE_CACHE_RECENT_MESSAGES;
}

function markClaudeCacheControlOnMessage(message, cacheTTL, reason) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
        return false;
    }

    for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i];
        if (!block || block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) {
            continue;
        }

        block.cache_control = { type: 'ephemeral', ttl: cacheTTL };
        console.info(\`[Claude Cache Anchor] Applied fallback cache_control ttl=\${cacheTTL} to role=\${message.role || 'unknown'}, reason=\${reason}.\`);
        return true;
    }

    return false;
}

function applyClaudeCacheFallbackAtRecentWindow(requestBody, cacheTTL, recentMessages = ST_CLAUDE_CACHE_RECENT_MESSAGES) {
    if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
        return false;
    }

    const targetStart = requestBody.messages.length > recentMessages
        ? requestBody.messages.length - recentMessages - 1
        : requestBody.messages.length - 1;

    for (let i = targetStart; i >= 0; i--) {
        if (markClaudeCacheControlOnMessage(requestBody.messages[i], cacheTTL, \`before-last-\${recentMessages}-messages\`)) {
            console.info(\`[Claude Cache Anchor] Fallback inspected messages=\${requestBody.messages.length}, targetIndex=\${i}.\`);
            return true;
        }
    }

    console.warn(\`[Claude Cache Anchor] Fallback found no text message to mark. messages=\${requestBody.messages.length}.\`);
    return false;
}

`;
        text = text.replace('function applyClaudeCacheAnchorToContentBlocks(blocks, cacheTTL) {', `${fallbackUpgradeBlock}function applyClaudeCacheAnchorToContentBlocks(blocks, cacheTTL) {`);
    }

    text = ensureClaudeCacheTTL(text);
    text = ensureManualCacheAnchorCall(text);

    text = text.replace(
        /if \(enableSystemPromptCache \|\| cachingAtDepth !== -1\) \{/,
        'if (enableSystemPromptCache || cachingAtDepth !== -1 || hasManualCacheAnchor) {',
    );

    fs.writeFileSync(target, text);
    console.log(`[Claude Cache Anchor] Backend patch installed: ${target}`);
    console.log('[Claude Cache Anchor] Restart SillyTavern to load the patch.');
}

try {
    install();
} catch (error) {
    console.error(`[Claude Cache Anchor] Install failed: ${error.message}`);
    process.exit(1);
}
