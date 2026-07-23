import { loadCatalogSnippet } from '../services/prompt-builder.js';
import { getClaudeAuthStatus, type ClaudeAuthStatus } from '../services/claude-auth.js';
import { getIntegrationConfig } from './integration-config.js';
import { formatTelegramBotsPromptBlock } from './telegram-bots.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface MetaExtrasCache {
  at: number;
  catalogSnippet: string;
  claudeAuth: ClaudeAuthStatus;
  telegramBotsBlock: string;
}

let cache: MetaExtrasCache | null = null;

/** Catalog + Claude auth + telegram bots block — cached ~5 minutes. */
export async function getCachedMetaAgentExtras(): Promise<{
  catalogSnippet: string;
  claudeAuth: ClaudeAuthStatus;
  telegramBotsBlock: string;
}> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return {
      catalogSnippet: cache.catalogSnippet,
      claudeAuth: cache.claudeAuth,
      telegramBotsBlock: cache.telegramBotsBlock,
    };
  }

  const [catalogSnippet, claudeAuth, integrationCfg] = await Promise.all([
    loadCatalogSnippet(),
    getClaudeAuthStatus(),
    getIntegrationConfig(),
  ]);
  const telegramBotsBlock = formatTelegramBotsPromptBlock(integrationCfg.telegram);
  cache = { at: now, catalogSnippet, claudeAuth, telegramBotsBlock };
  return { catalogSnippet, claudeAuth, telegramBotsBlock };
}

/** Test helper / force refresh after settings change. */
export function clearMetaAgentExtrasCache(): void {
  cache = null;
}
