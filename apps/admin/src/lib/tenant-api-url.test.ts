import { describe, expect, it } from 'vitest';
import { altegioWebhookUrl, resolveApiHostFromAdmin, tenantApiOrigin } from './tenant-api-url';

describe('tenant API URL', () => {
  it('maps this admin host to the tenant API', () => {
    expect(resolveApiHostFromAdmin('agent.salon.example')).toBe('api.salon.example');
    expect(resolveApiHostFromAdmin('agent-sb.platform.example')).toBe('api-sb.platform.example');
    expect(tenantApiOrigin('agent-sb.platform.example')).toBe('https://api-sb.platform.example');
    expect(tenantApiOrigin('localhost')).toBe('http://localhost:3000');
  });

  it('builds a copyable Altegio callback for this tenant', () => {
    expect(altegioWebhookUrl('agent-sb.platform.example')).toBe(
      'https://api-sb.platform.example/webhooks/altegio',
    );
    expect(altegioWebhookUrl('agent-sb.platform.example', '••••••')).toBe(
      'https://api-sb.platform.example/webhooks/altegio',
    );
    expect(altegioWebhookUrl('agent-sb.platform.example', 'hook secret')).toBe(
      'https://api-sb.platform.example/webhooks/altegio?token=hook%20secret',
    );
  });
});
