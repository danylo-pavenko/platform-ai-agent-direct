import { BASE } from '../constants.js';
import { nowTime } from '../utils.js';

export function createChat(deps) {
  const { chat, chatMessages, claudeHealth, authHeaders, headers, nextTick } = deps;

  function chatTenantName() {
    return (chat.tenant && chat.tenant.name) || '—';
  }

  function chatTenantDomain() {
    return (chat.tenant && chat.tenant.apiDomain) || '';
  }

  async function checkClaudeHealth(t) {
    claudeHealth.loading = t.id;
    claudeHealth.tenantName = t.name;
    claudeHealth.result = null;
    claudeHealth.open = true;
    try {
      const r = await fetch(`${BASE}/tenants/${t.id}/claude-health`, { headers: authHeaders() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        claudeHealth.result = { ok: false, path: '', version: '', error: d.error || `HTTP ${r.status}` };
      } else {
        claudeHealth.result = d;
      }
    } catch (e) {
      claudeHealth.result = { ok: false, path: '', version: '', error: e.message };
    } finally {
      claudeHealth.loading = null;
    }
  }

  function openChat(t) {
    chat.tenant = t;
    chat.messages = [];
    chat.history = [];
    chat.input = '';
    chat.open = true;
  }

  async function sendChat() {
    const text = chat.input.trim();
    if (!text || chat.typing) return;
    chat.input = '';
    chat.messages.push({ role: 'user', content: text, time: nowTime() });
    chat.history.push({ role: 'user', content: text });
    chat.typing = true;
    await nextTick();
    if (chatMessages.value) chatMessages.value.scrollTop = chatMessages.value.scrollHeight;

    try {
      const r = await fetch(`${BASE}/tenants/${chat.tenant.id}/chat`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ message: text, history: chat.history }),
      });
      const d = await r.json();
      const reply = d.reply || d.text || d.error || 'Немає відповіді';
      chat.messages.push({ role: 'bot', content: reply, time: nowTime() });
      chat.history.push({ role: 'assistant', content: reply });
    } catch {
      chat.messages.push({ role: 'bot', content: '⚠️ Агент недоступний', time: nowTime() });
    }
    chat.typing = false;
    await nextTick();
    if (chatMessages.value) chatMessages.value.scrollTop = chatMessages.value.scrollHeight;
  }

  return {
    chatTenantName,
    chatTenantDomain,
    checkClaudeHealth,
    openChat,
    sendChat,
  };
}
