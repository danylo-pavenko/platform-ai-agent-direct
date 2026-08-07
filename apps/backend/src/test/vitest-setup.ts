/**
 * Ensure required env exists before any test imports `config.ts`.
 * Avoids process.exit(1) when developers/CI run tests without a root .env.
 */
const defaults: Record<string, string> = {
  ADMIN_DOMAIN: 'admin.test.local',
  API_DOMAIN: 'api.test.local',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/platform_ai_agent_test',
  JWT_SECRET: 'test-jwt-secret-16chars',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key] || process.env[key]!.trim() === '') {
    process.env[key] = value;
  }
}
