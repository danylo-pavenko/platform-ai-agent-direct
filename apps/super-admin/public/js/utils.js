export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('uk', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatInstagram(handle) {
  if (!handle) return '';
  return '@' + String(handle).replace(/^@+/, '');
}

/** ISO string → value for <input type="datetime-local"> (local time) */
export function isoToLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    prompt('Copy:', text);
  }
}

export function nowTime() {
  return new Date().toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' });
}

export function escapeLine(line) {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isAbortError(e) {
  return e && (e.name === 'AbortError' || e.code === 20);
}

export function tenantWhisperPort(apiPort) {
  return apiPort ? apiPort + 5000 : '—';
}
