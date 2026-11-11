/**
 * Client conversation language: uk | ru | en.
 * A code, «ок», or a photo is not a language. Cyrillic alone is not Ukrainian.
 */

export type ClientLanguage = 'uk' | 'ru' | 'en';

const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[A-Za-z]/g;
const UK_LETTERS_RE = /[іїєґІЇЄҐ]/g;
const RU_LETTERS_RE = /[ыэёъЫЭЁЪ]/g;

const UK_WORDS = [
  'будь ласка',
  'підкажіть',
  'напишіть',
  'двигун',
  'який',
  'дякую',
  'вітаю',
  'привіт',
  'прошити',
  'добрий',
  'записатись',
  'записатися',
];

const RU_WORDS = [
  'пожалуйста',
  'подскажите',
  'напишите',
  'двигатель',
  'какой',
  'спасибо',
  'здравствуйте',
  'привет',
  'прошить',
  'добрый',
  'может',
  'машина',
];

const EN_WORDS = [
  'hello',
  'hi',
  'please',
  'thanks',
  'thank',
  'want',
  'would',
  'could',
  'the',
  'what',
  'which',
  'engine',
  'price',
];

export function normalizeClientLanguage(value: unknown): ClientLanguage | null {
  if (value === 'uk' || value === 'ru' || value === 'en') return value;
  if (typeof value === 'string') {
    const folded = value.trim().toLowerCase();
    if (folded === 'uk' || folded === 'ua' || folded === 'ukrainian' || folded === 'українська') {
      return 'uk';
    }
    if (folded === 'ru' || folded === 'russian' || folded === 'російська' || folded === 'русский') {
      return 'ru';
    }
    if (folded === 'en' || folded === 'english' || folded === 'англійська') return 'en';
  }
  return null;
}

export function clientLanguageLabel(lang: ClientLanguage): string {
  if (lang === 'ru') return 'російська';
  if (lang === 'en') return 'англійська';
  return 'українська';
}

function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+|www\.\S+|t\.me\/\S+/gi, ' ');
}

const RU_ASK = /(?:по[-\s]?русски|на русском|російською|на російській|русском языке)/u;
const UK_ASK = /(?:українською|на українській|по[-\s]?українськи|українською мовою)/u;
const EN_ASK = /(?:\bin english\b|speak english|англійською|на англійській|на английском|по[-\s]?английски|по[-\s]?англійськи)/u;
const ASK_CUE =
  /(?:говори(?:те|ти)?|пиш(?:и|ите|іть)|отвеч(?:ай|айте)|відповіда(?:й|йте)|спілку|обща(?:йся|йтесь)|перейд(?:и|іть|ите)|переключ|давай(?:те)?|можна|можно|только|тільки|пожалуйста|будь ласка|please|switch to|speak|reply in)/u;

function askedFor(sample: string, name: RegExp): boolean {
  if (!name.test(sample)) return false;
  const letters = sample.replace(/[^\p{L}]/gu, '');
  if (letters.length <= 48) return true;
  return ASK_CUE.test(sample);
}

function hits(text: string, words: readonly string[]): number {
  const hay = fold(text);
  return words.reduce((count, word) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    return re.test(hay) ? count + 1 : count;
  }, 0);
}

/**
 * Language of this message, or null when it does not decide one.
 * Only a clear signal is returned, so a saved language is not overwritten by «ок».
 */
export function detectClientLanguage(text: string): ClientLanguage | null {
  const sample = withoutUrls(text).trim();
  if (sample.length < 2) return null;

  const ukLetters = (sample.match(UK_LETTERS_RE) ?? []).length;
  const ruLetters = (sample.match(RU_LETTERS_RE) ?? []).length;
  const ukWords = hits(sample, UK_WORDS);
  const ruWords = hits(sample, RU_WORDS);
  const ukScore = ukLetters + ukWords * 2;
  const ruScore = ruLetters + ruWords * 2;

  if (ukScore > 0 || ruScore > 0) {
    if (ukScore === ruScore) return null;
    return ukScore > ruScore ? 'uk' : 'ru';
  }

  const cyr = (sample.match(CYRILLIC_RE) ?? []).length;
  const lat = (sample.match(LATIN_RE) ?? []).length;
  if (lat >= 3 && lat >= cyr * 1.2 && hits(sample, EN_WORDS) > 0) return 'en';
  return null;
}

/**
 * The person named the language they want. Ordinary text in that language is not a request.
 * A link, a number, or a long product sentence that merely contains «українською» is not either.
 */
export function detectRequestedLanguage(text: string): ClientLanguage | null {
  const sample = fold(withoutUrls(text)).replace(/\s+/g, ' ').trim();
  if (!sample) return null;
  const found: ClientLanguage[] = [];
  if (askedFor(sample, RU_ASK)) found.push('ru');
  if (askedFor(sample, UK_ASK)) found.push('uk');
  if (askedFor(sample, EN_ASK)) found.push('en');
  return found.length === 1 ? found[0] : null;
}

/**
 * What to write on the card, or null to leave it.
 * A clear language locks on the first or second client message.
 * Later messages do not switch it. An explicit request does, and then stays.
 */
export function languageToStore(input: {
  stored: unknown;
  text: string;
  inboundOrdinal: number;
}): ClientLanguage | null {
  const stored = normalizeClientLanguage(input.stored);
  const requested = detectRequestedLanguage(input.text);
  if (requested && requested !== stored) return requested;
  if (stored) return null;
  if (input.inboundOrdinal > 2) return null;
  const detected = detectClientLanguage(input.text);
  if (!detected) return null;
  return detected;
}
