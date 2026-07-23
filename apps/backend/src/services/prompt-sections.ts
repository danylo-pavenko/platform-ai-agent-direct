/**
 * Split system prompts into sections for lean meta-agent context.
 * Prefers ═══ SECTION ═══ markers, then markdown #/##, else fixed windows.
 */

export interface PromptSection {
  id: string;
  title: string;
  content: string;
  start: number;
  end: number;
}

const DOUBLE_LINE = /^═══\s*(.+?)\s*═══\s*$/gm;
const MD_HEADER = /^(#{1,3})\s+(.+)$/gm;
const WINDOW_CHARS = 3500;
const MAX_SELECTED = 3;
const FULL_PROMPT_SECTION_THRESHOLD = 2;

function slugify(title: string, index: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base ? `${index}-${base}` : `section-${index}`;
}

function splitByRegex(
  content: string,
  re: RegExp,
  titleFromMatch: (m: RegExpExecArray) => string,
): PromptSection[] | null {
  const matches: Array<{ index: number; title: string; headerLen: number }> = [];
  const flags = (re.flags ?? '').includes('g') ? re.flags : `${re.flags ?? ''}g`;
  const matcher = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(content)) !== null) {
    matches.push({
      index: m.index,
      title: titleFromMatch(m).trim() || `Section ${matches.length + 1}`,
      headerLen: m[0].length,
    });
  }
  if (matches.length < 2) return null;

  const sections: PromptSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const body = content.slice(start, end).trimEnd();
    sections.push({
      id: slugify(matches[i].title, i),
      title: matches[i].title,
      content: body,
      start,
      end,
    });
  }
  return sections;
}

function splitByWindows(content: string): PromptSection[] {
  const sections: PromptSection[] = [];
  let offset = 0;
  let i = 0;
  while (offset < content.length) {
    let end = Math.min(offset + WINDOW_CHARS, content.length);
    if (end < content.length) {
      const nl = content.lastIndexOf('\n\n', end);
      if (nl > offset + WINDOW_CHARS / 2) end = nl;
    }
    const chunk = content.slice(offset, end);
    const titlePreview = chunk.replace(/\s+/g, ' ').trim().slice(0, 40) || `Window ${i + 1}`;
    sections.push({
      id: slugify(titlePreview, i),
      title: `Частина ${i + 1}`,
      content: chunk,
      start: offset,
      end,
    });
    offset = end;
    i += 1;
  }
  return sections.length > 0
    ? sections
    : [{ id: 'section-0', title: 'Промпт', content, start: 0, end: content.length }];
}

export function splitPromptSections(content: string): PromptSection[] {
  const text = content ?? '';
  if (!text.trim()) {
    return [{ id: 'section-0', title: 'Промпт', content: text, start: 0, end: 0 }];
  }

  const byBars = splitByRegex(text, DOUBLE_LINE, (m) => m[1] ?? '');
  if (byBars) return byBars;

  const byMd = splitByRegex(text, MD_HEADER, (m) => m[2] ?? '');
  if (byMd) return byMd;

  // Emoji / ALL-CAPS short headers (sales-agent-ig-dm style): line with few words
  const emojiHeader = /^([\p{Emoji}\p{So}]+\s+.+|[A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ\s/—-]{3,80})$/gmu;
  const byEmoji = splitByRegex(text, emojiHeader, (m) => m[1] ?? m[0]);
  if (byEmoji && byEmoji.length >= 3) return byEmoji;

  return splitByWindows(text);
}

export function buildSectionToc(sections: PromptSection[]): string {
  return sections.map((s, i) => `${i + 1}. [${s.id}] ${s.title}`).join('\n');
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

export function selectRelevantSections(
  userMessage: string,
  sections: PromptSection[],
  limit = MAX_SELECTED,
): PromptSection[] {
  if (sections.length === 0) return [];
  if (sections.length <= FULL_PROMPT_SECTION_THRESHOLD) return [...sections];

  const query = tokenize(userMessage);
  if (query.size === 0) {
    return sections.slice(0, Math.min(limit, sections.length));
  }

  const scored = sections.map((section) => {
    const hay = tokenize(`${section.title}\n${section.content}`);
    let score = 0;
    for (const t of query) {
      if (hay.has(t)) score += 1;
      if (section.title.toLowerCase().includes(t)) score += 2;
    }
    return { section, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, limit);
  if (top.length === 0) {
    // No keyword hit — return first sections so Claude still has structure
    return sections.slice(0, Math.min(limit, sections.length));
  }
  // Preserve document order for easier editing
  const ids = new Set(top.map((t) => t.section.id));
  return sections.filter((s) => ids.has(s.id));
}

export interface MetaPromptContext {
  /** Text injected as <current_prompt> (full or TOC+sections). */
  promptBlock: string;
  usedFullPrompt: boolean;
  selectedSectionIds: string[];
  sectionCount: number;
}

/**
 * Build lean prompt context: TOC + relevant sections, or full prompt when small/ambiguous.
 */
export function buildMetaPromptContext(
  fullContent: string,
  userMessage: string,
): MetaPromptContext {
  const sections = splitPromptSections(fullContent);
  if (sections.length <= FULL_PROMPT_SECTION_THRESHOLD) {
    return {
      promptBlock: fullContent,
      usedFullPrompt: true,
      selectedSectionIds: sections.map((s) => s.id),
      sectionCount: sections.length,
    };
  }

  const selected = selectRelevantSections(userMessage, sections, MAX_SELECTED);
  const scoredAny = selected.some((s) => {
    const q = tokenize(userMessage);
    const hay = tokenize(`${s.title}\n${s.content}`);
    for (const t of q) if (hay.has(t)) return true;
    return false;
  });

  // Weak localization → send full prompt to avoid wrong-section edits
  if (!scoredAny && userMessage.trim().length > 0) {
    const strong = selectRelevantSections(userMessage, sections, MAX_SELECTED);
    const bestScore = (() => {
      const q = tokenize(userMessage);
      let best = 0;
      for (const s of sections) {
        const hay = tokenize(`${s.title}\n${s.content}`);
        let score = 0;
        for (const t of q) {
          if (hay.has(t)) score += 1;
        }
        best = Math.max(best, score);
      }
      return best;
    })();
    if (bestScore === 0 && fullContent.length < 40_000) {
      return {
        promptBlock: fullContent,
        usedFullPrompt: true,
        selectedSectionIds: sections.map((s) => s.id),
        sectionCount: sections.length,
      };
    }
    void strong;
  }

  const toc = buildSectionToc(sections);
  const body = selected
    .map((s) => `<section id="${s.id}" title="${s.title}">\n${s.content}\n</section>`)
    .join('\n\n');

  const promptBlock = `<prompt_toc>
Повний зміст секцій промпту (редагуй лише релевантні; у before копіюй ТОЧНИЙ текст із наведених секцій):
${toc}
</prompt_toc>

<selected_sections>
${body}
</selected_sections>

Якщо потрібна секція, якої немає вище — попроси адміна уточнити або запропонуй append з порожнім before.`;

  return {
    promptBlock,
    usedFullPrompt: false,
    selectedSectionIds: selected.map((s) => s.id),
    sectionCount: sections.length,
  };
}
