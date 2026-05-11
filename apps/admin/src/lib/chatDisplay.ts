/**
 * Plain text for chat bubbles (Instagram does not use Markdown; DB may still hold legacy `**`).
 */
export function formatChatPlain(text: string | null | undefined): string {
  if (text == null || text === '') return '';
  let s = text;
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  return s;
}
