import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    link({ href, title, text }) {
      const safeHref = href ?? '#';
      const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
  },
});

/**
 * Renders meta-agent chat replies as sanitized HTML from Markdown (GFM).
 */
export function formatMetaAgentMarkdown(text: string | null | undefined): string {
  if (text == null || text === '') return '';

  const html = marked.parse(text, { async: false }) as string;

  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}
