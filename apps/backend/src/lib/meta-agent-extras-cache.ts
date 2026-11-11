import { loadCatalogSnippet } from '../services/prompt-builder.js';
import { getClaudeAuthStatus, type ClaudeAuthStatus } from '../services/claude-auth.js';
import { getIntegrationConfig } from './integration-config.js';
import { formatTelegramBotsPromptBlock } from './telegram-bots.js';
import { loadMetaAgentLibraryIndex } from '../services/library.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Library index changes often during teach — shorter TTL than catalog. */
const LIBRARY_CACHE_TTL_MS = 60 * 1000;

interface MetaExtrasCache {
  at: number;
  catalogSnippet: string;
  claudeAuth: ClaudeAuthStatus;
  telegramBotsBlock: string;
  libraryIndex: string;
  libraryAt: number;
}

let cache: MetaExtrasCache | null = null;

/** Catalog + Claude auth + telegram bots + library index — cached. */
export async function getCachedMetaAgentExtras(): Promise<{
  catalogSnippet: string;
  claudeAuth: ClaudeAuthStatus;
  telegramBotsBlock: string;
  libraryIndex: string;
}> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    if (now - cache.libraryAt < LIBRARY_CACHE_TTL_MS) {
      return {
        catalogSnippet: cache.catalogSnippet,
        claudeAuth: cache.claudeAuth,
        telegramBotsBlock: cache.telegramBotsBlock,
        libraryIndex: cache.libraryIndex,
      };
    }
    const libraryIndex = await loadMetaAgentLibraryIndex();
    cache = { ...cache, libraryIndex, libraryAt: now };
    return {
      catalogSnippet: cache.catalogSnippet,
      claudeAuth: cache.claudeAuth,
      telegramBotsBlock: cache.telegramBotsBlock,
      libraryIndex,
    };
  }

  const [catalogSnippet, claudeAuth, integrationCfg, libraryIndex] = await Promise.all([
    loadCatalogSnippet(),
    getClaudeAuthStatus(),
    getIntegrationConfig(),
    loadMetaAgentLibraryIndex(),
  ]);
  const telegramBotsBlock = formatTelegramBotsPromptBlock(integrationCfg.telegram);
  cache = {
    at: now,
    catalogSnippet,
    claudeAuth,
    telegramBotsBlock,
    libraryIndex,
    libraryAt: now,
  };
  return { catalogSnippet, claudeAuth, telegramBotsBlock, libraryIndex };
}

/** Test helper / force refresh after settings change. */
export function clearMetaAgentExtrasCache(): void {
  cache = null;
}
