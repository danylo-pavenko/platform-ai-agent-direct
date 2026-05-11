/**
 * Normalizes assistant / manager text for Instagram DM.
 * IG does not render Markdown — users would see literal `**` otherwise.
 */
export function stripMarkdownForInstagram(text: string): string {
  let s = text;
  // Bold **...** (non-greedy, no nested **)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // Bold __...__
  s = s.replace(/__([^_]+)__/g, '$1');
  // Strikethrough ~~...~~
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // Links [label](url) → "label (url)" so nothing is lost
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  // Inline `code`
  s = s.replace(/`([^`]+)`/g, '$1');
  return s;
}
