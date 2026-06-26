import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { IGNORE_SYMBOL } from '/scripts/constants.js';
import { isTrueBoolean } from '/scripts/utils.js';

const SETTINGS_KEY = 'claudeCacheAnchor';
const MODULE_NAME = 'third-party/Claude-Cache-Anchor';

const ANCHOR_MARKER = '<!-- ST_CLAUDE_CACHE_ANCHOR -->';
const CACHE_TTL_OPTIONS = ['1h', '5m'];

console.info('[Claude Cache Anchor] Script loaded.');

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: 'before-recent-body-window',
    recentMessages: 5,
    cacheTTL: '1h',
    systemIndex: 1,
    summaryTitle: '摘要',
    manualRegex: '',
});

function normalizeCacheTTL(value) {
    const ttl = String(value || '').trim();
    return CACHE_TTL_OPTIONS.includes(ttl) ? ttl : DEFAULT_SETTINGS.cacheTTL;
}

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    if (!['before-recent-body-window', 'system-last', 'system-index', 'first-managed-summary', 'manual-regex'].includes(settings.mode)) {
        settings.mode = DEFAULT_SETTINGS.mode;
    }

    const parsedRecentMessages = Number.parseInt(String(settings.recentMessages ?? ''), 10);
    settings.recentMessages = Number.isInteger(parsedRecentMessages) && parsedRecentMessages > 0 ? parsedRecentMessages : DEFAULT_SETTINGS.recentMessages;
    settings.cacheTTL = normalizeCacheTTL(settings.cacheTTL);

    const parsedSystemIndex = Number.parseInt(String(settings.systemIndex ?? ''), 10);
    settings.systemIndex = Number.isInteger(parsedSystemIndex) && parsedSystemIndex > 0 ? parsedSystemIndex : DEFAULT_SETTINGS.systemIndex;
    settings.summaryTitle = String(settings.summaryTitle || '').trim() || DEFAULT_SETTINGS.summaryTitle;
    settings.manualRegex = String(settings.manualRegex || '').trim();

    return settings;
}

function saveSettings() {
    saveSettingsDebounced();
    updateStatus();
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSummaryRegex(summaryTitle) {
    const title = escapeRegex(summaryTitle.trim() || DEFAULT_SETTINGS.summaryTitle);
    return new RegExp(`<details\\b[^>]*>\\s*<summary\\b[^>]*>\\s*${title}\\s*<\\/summary>[\\s\\S]*?<\\/details>`, 'i');
}

function stripAnchorMarkers(text) {
    return String(text ?? '').split(ANCHOR_MARKER).join('');
}

function appendAnchorMarker(text) {
    return `${stripAnchorMarkers(text).trimEnd()}\n${ANCHOR_MARKER}`;
}

function getTextTarget(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    if (typeof message.content === 'string') {
        return {
            getText: () => message.content,
            setText: (value) => {
                message.content = value;
            },
        };
    }

    if (Array.isArray(message.content)) {
        for (let i = message.content.length - 1; i >= 0; i--) {
            const part = message.content[i];
            if (typeof part === 'string') {
                return {
                    getText: () => message.content[i],
                    setText: (value) => {
                        message.content[i] = value;
                    },
                };
            }
            if (part && typeof part === 'object' && typeof part.text === 'string') {
                return {
                    getText: () => part.text,
                    setText: (value) => {
                        part.text = value;
                    },
                };
            }
        }
    }

    if (message.content && typeof message.content === 'object' && typeof message.content.text === 'string') {
        return {
            getText: () => message.content.text,
            setText: (value) => {
                message.content.text = value;
            },
        };
    }

    return null;
}

function cleanExistingMarkers(chat) {
    for (const message of chat) {
        const target = getTextTarget(message);
        if (!target) {
            continue;
        }

        const cleanText = stripAnchorMarkers(target.getText());
        if (cleanText !== target.getText()) {
            target.setText(cleanText);
        }
    }
}

function findLastEarlySystemIndex(chat) {
    let lastSystemIndex = -1;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.role !== 'system') {
            break;
        }
        if (getTextTarget(chat[i])) {
            lastSystemIndex = i;
        }
    }
    return lastSystemIndex;
}

function isPromptHiddenMessage(message) {
    return Boolean(message?.is_system || message?.extra?.[IGNORE_SYMBOL]);
}

function isConversationMessage(message) {
    return !isPromptHiddenMessage(message)
        && ['user', 'assistant', 'tool'].includes(message?.role)
        && getTextTarget(message);
}

function findBeforeRecentBodyWindowIndex(chat, recentMessages) {
    const normalizedRecentMessages = Number.isInteger(recentMessages) && recentMessages > 0
        ? recentMessages
        : DEFAULT_SETTINGS.recentMessages;
    let seenConversationMessages = 0;
    let windowStartIndex = chat.length;

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];

        if (message?.role === 'assistant' && !getTextTarget(message)) {
            continue;
        }

        if (!isConversationMessage(message)) {
            continue;
        }

        seenConversationMessages += 1;
        windowStartIndex = i;

        if (seenConversationMessages >= normalizedRecentMessages) {
            break;
        }
    }

    for (let i = windowStartIndex - 1; i >= 0; i--) {
        if (!isPromptHiddenMessage(chat[i]) && getTextTarget(chat[i])) {
            return i;
        }
    }

    return findLastEarlySystemIndex(chat);
}

function findSystemNumberIndex(chat, systemNumber) {
    let seen = 0;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.role !== 'system') {
            break;
        }
        if (!getTextTarget(chat[i])) {
            continue;
        }
        seen += 1;
        if (seen === systemNumber) {
            return i;
        }
    }
    return -1;
}

function findFirstManagedSummaryIndex(chat, summaryTitle) {
    const summaryRegex = createSummaryRegex(summaryTitle);
    for (let i = 0; i < chat.length; i++) {
        const target = getTextTarget(chat[i]);
        if (target && summaryRegex.test(target.getText())) {
            return i;
        }
    }
    return -1;
}

function findManualRegexIndex(chat, regexText) {
    if (!regexText) {
        return -1;
    }

    let regex;
    try {
        regex = new RegExp(regexText, 'i');
    } catch {
        return -1;
    }

    for (let i = 0; i < chat.length; i++) {
        const target = getTextTarget(chat[i]);
        if (target && regex.test(target.getText())) {
            return i;
        }
    }

    return -1;
}

function findAnchorIndex(chat, settings) {
    switch (settings.mode) {
        case 'before-recent-body-window':
            return findBeforeRecentBodyWindowIndex(chat, settings.recentMessages);
        case 'system-index':
            return findSystemNumberIndex(chat, settings.systemIndex);
        case 'first-managed-summary':
            return findFirstManagedSummaryIndex(chat, settings.summaryTitle);
        case 'manual-regex':
            return findManualRegexIndex(chat, settings.manualRegex);
        case 'system-last':
        default:
            return findLastEarlySystemIndex(chat);
    }
}

function describeIndex(index, chat) {
    if (index < 0) {
        return 'No anchor target found.';
    }

    const message = chat[index];
    const target = getTextTarget(message);
    const preview = stripAnchorMarkers(target?.getText() ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `Anchor target: #${index + 1}, role=${message.role || 'unknown'}, preview="${preview}".`;
}

function applyAnchorMarker(eventData) {
    const settings = getSettings();
    if (!settings.enabled || !Array.isArray(eventData?.chat) || eventData.dryRun === true) {
        return;
    }

    cleanExistingMarkers(eventData.chat);

    const anchorIndex = findAnchorIndex(eventData.chat, settings);
    if (anchorIndex < 0) {
        console.warn('[Claude Cache Anchor] No anchor target found for mode:', settings.mode);
        return;
    }

    const target = getTextTarget(eventData.chat[anchorIndex]);
    if (!target) {
        console.warn('[Claude Cache Anchor] Anchor target has no editable text:', anchorIndex);
        return;
    }

    target.setText(appendAnchorMarker(target.getText()));
    console.info('[Claude Cache Anchor] Inserted marker.', describeIndex(anchorIndex, eventData.chat));
}

function analyzeCurrentPrompt() {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat ?? [];
    const index = findAnchorIndex(chat, settings);
    const windowText = settings.mode === 'before-recent-body-window'
        ? ` recentMessages=${settings.recentMessages}.`
        : '';
    return `[${settings.enabled ? 'enabled' : 'disabled'}] mode=${settings.mode}.${windowText} cacheTTL=${settings.cacheTTL}. ${describeIndex(index, chat)}`;
}

function updateStatus() {
    const statusElement = $('#claude_cache_anchor_status');
    if (!statusElement.length) {
        return;
    }

    statusElement.text(analyzeCurrentPrompt());
}

function syncSettingsUi() {
    const settings = getSettings();
    $('#claude_cache_anchor_enabled').prop('checked', !!settings.enabled);
    $('#claude_cache_anchor_mode').val(settings.mode);
    $('#claude_cache_anchor_recent_messages').val(settings.recentMessages);
    $('#claude_cache_anchor_cache_ttl').val(settings.cacheTTL);
    $('#claude_cache_anchor_system_index').val(settings.systemIndex);
    $('#claude_cache_anchor_summary_title').val(settings.summaryTitle);
    $('#claude_cache_anchor_regex').val(settings.manualRegex);
    updateStatus();
}

function restoreDefaults() {
    extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    syncSettingsUi();
    saveSettings();
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'claudecache-status',
        callback: () => analyzeCurrentPrompt(),
        returns: 'current Claude cache anchor status',
        helpString: 'Show current Claude Cache Anchor target for the active chat.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'claudecache-set',
        callback: (args) => {
            const settings = getSettings();

            if (args.enabled !== undefined && args.enabled !== '') {
                settings.enabled = isTrueBoolean(String(args.enabled));
            }

            if (args.mode !== undefined && args.mode !== '') {
                const mode = String(args.mode);
                if (['before-recent-body-window', 'system-last', 'system-index', 'first-managed-summary', 'manual-regex'].includes(mode)) {
                    settings.mode = mode;
                }
            }

            if (args.recentMessages !== undefined && args.recentMessages !== '') {
                const parsedValue = Number.parseInt(String(args.recentMessages), 10);
                if (Number.isInteger(parsedValue) && parsedValue > 0) {
                    settings.recentMessages = parsedValue;
                }
            }

            if (args.cacheTTL !== undefined && args.cacheTTL !== '') {
                settings.cacheTTL = normalizeCacheTTL(args.cacheTTL);
            }

            if (args.systemIndex !== undefined && args.systemIndex !== '') {
                const parsedValue = Number.parseInt(String(args.systemIndex), 10);
                if (Number.isInteger(parsedValue) && parsedValue > 0) {
                    settings.systemIndex = parsedValue;
                }
            }

            if (args.summary !== undefined && args.summary !== '') {
                settings.summaryTitle = String(args.summary).trim() || DEFAULT_SETTINGS.summaryTitle;
            }

            if (args.regex !== undefined) {
                settings.manualRegex = String(args.regex).trim();
            }

            syncSettingsUi();
            saveSettings();
            return analyzeCurrentPrompt();
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'enabled',
                description: 'enable or disable the extension',
                typeList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'anchor mode',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumList: ['before-recent-body-window', 'system-last', 'system-index', 'first-managed-summary', 'manual-regex'],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'recentMessages',
                description: 'number of newest prompt messages to keep after the anchor',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cacheTTL',
                description: 'Claude prompt cache time',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumList: CACHE_TTL_OPTIONS,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'systemIndex',
                description: '1-based early system message number for system-index mode',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'summary',
                description: 'summary heading for first-managed-summary mode',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'regex',
                description: 'regex for manual-regex mode',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
        ],
        returns: 'updated Claude cache anchor config',
        helpString: 'Update Claude Cache Anchor settings. Example: /claudecache-set enabled=true mode=system-last',
    }));
}

async function addSettingsUi() {
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    const containerId = 'claude_cache_anchor_container';

    if (!document.getElementById(containerId)) {
        $('#extensions_settings2').append(`<div id="${containerId}" class="extension_container"></div>`);
    }

    $(`#${containerId}`).empty().append(settingsHtml);

    $('#claude_cache_anchor_enabled').on('input', () => {
        getSettings().enabled = $('#claude_cache_anchor_enabled').prop('checked');
        saveSettings();
    });

    $('#claude_cache_anchor_mode').on('change', () => {
        getSettings().mode = String($('#claude_cache_anchor_mode').val());
        saveSettings();
    });

    $('#claude_cache_anchor_recent_messages').on('change', () => {
        const settings = getSettings();
        const parsedValue = Number.parseInt(String($('#claude_cache_anchor_recent_messages').val()), 10);
        settings.recentMessages = Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_SETTINGS.recentMessages;
        $('#claude_cache_anchor_recent_messages').val(settings.recentMessages);
        saveSettings();
    });

    $('#claude_cache_anchor_cache_ttl').on('change', () => {
        const settings = getSettings();
        settings.cacheTTL = normalizeCacheTTL($('#claude_cache_anchor_cache_ttl').val());
        $('#claude_cache_anchor_cache_ttl').val(settings.cacheTTL);
        saveSettings();
    });

    $('#claude_cache_anchor_system_index').on('change', () => {
        const settings = getSettings();
        const parsedValue = Number.parseInt(String($('#claude_cache_anchor_system_index').val()), 10);
        settings.systemIndex = Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_SETTINGS.systemIndex;
        $('#claude_cache_anchor_system_index').val(settings.systemIndex);
        saveSettings();
    });

    $('#claude_cache_anchor_summary_title').on('input', () => {
        getSettings().summaryTitle = String($('#claude_cache_anchor_summary_title').val()).trim() || DEFAULT_SETTINGS.summaryTitle;
        saveSettings();
    });

    $('#claude_cache_anchor_regex').on('input', () => {
        getSettings().manualRegex = String($('#claude_cache_anchor_regex').val()).trim();
        saveSettings();
    });

    $('#claude_cache_anchor_refresh').on('click', updateStatus);
    $('#claude_cache_anchor_restore').on('click', restoreDefaults);
    syncSettingsUi();
}

jQuery(async () => {
    await addSettingsUi();
    registerSlashCommands();

    eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, applyAnchorMarker);
    eventSource.on(event_types.CHAT_CHANGED, updateStatus);
    eventSource.on(event_types.MESSAGE_SENT, updateStatus);
    eventSource.on(event_types.MESSAGE_RECEIVED, updateStatus);
    eventSource.on(event_types.MESSAGE_DELETED, updateStatus);
    eventSource.on(event_types.MESSAGE_EDITED, updateStatus);
    eventSource.on(event_types.MESSAGE_UPDATED, updateStatus);
    eventSource.on(event_types.MESSAGE_SWIPED, updateStatus);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, updateStatus);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, updateStatus);
});
