/**
 * Instagram Click-to-Direct (CTD) / ads referral from Meta messaging webhooks.
 * Present on message.referral (or messaging event.referral) when source=ADS.
 */

export interface IgAdReferral {
  source: string;
  type?: string;
  adId?: string;
  ref?: string;
  adTitle?: string;
  photoUrl?: string;
  videoUrl?: string;
  /** ISO timestamp when we first captured this payload. */
  capturedAt: string;
}

export function isAdsReferral(value: unknown): value is IgAdReferral {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.source === 'string' && v.source.toUpperCase() === 'ADS';
}

function pickString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Parse Meta referral object (message.referral or messaging[].referral).
 * Returns null when missing or not an ADS / useful referral.
 */
export function parseMetaAdReferral(
  raw: unknown,
  now: Date = new Date(),
): IgAdReferral | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const source = pickString(o.source);
  if (!source) return null;

  const adsContext =
    o.ads_context_data && typeof o.ads_context_data === 'object' && !Array.isArray(o.ads_context_data)
      ? (o.ads_context_data as Record<string, unknown>)
      : null;

  const adId =
    pickString(o.ad_id)
    ?? (typeof o.ad_id === 'number' ? String(o.ad_id) : undefined);
  const ref = pickString(o.ref);
  const type = pickString(o.type);
  const adTitle = pickString(adsContext?.ad_title) ?? pickString(o.ad_title);
  const photoUrl = pickString(adsContext?.photo_url);
  const videoUrl = pickString(adsContext?.video_url);

  // CTD ads: source ADS. Also keep SHORTLINK with ref for attribution.
  const upper = source.toUpperCase();
  if (upper !== 'ADS' && upper !== 'SHORTLINK' && upper !== 'IG_SHOPPING') {
    return null;
  }

  return {
    source: upper,
    ...(type ? { type } : {}),
    ...(adId ? { adId } : {}),
    ...(ref ? { ref } : {}),
    ...(adTitle ? { adTitle } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    capturedAt: now.toISOString(),
  };
}

export function formatAdReferralLabel(referral: IgAdReferral): string {
  if (referral.source === 'ADS') {
    if (referral.adTitle) return `Реклама · ${referral.adTitle}`;
    if (referral.adId) return `Реклама · ${referral.adId}`;
    return 'Реклама Instagram';
  }
  if (referral.source === 'SHORTLINK') {
    return referral.ref ? `Посилання · ${referral.ref}` : 'Посилання ig.me';
  }
  return referral.source;
}

export function buildAdReferralPromptBlock(referral: IgAdReferral): string {
  const lines = [
    '[Клієнт прийшов з Instagram-реклами / атрибуції Direct]',
    `Джерело: ${referral.source}${referral.type ? ` (${referral.type})` : ''}.`,
  ];
  if (referral.adTitle) lines.push(`Креатив: «${referral.adTitle}».`);
  if (referral.adId) lines.push(`ad_id: ${referral.adId} (внутрішнє — не світи клієнту).`);
  if (referral.ref) lines.push(`ref: ${referral.ref}.`);
  lines.push(
    'Підхопи офер/послугу з креативу, якщо це зрозуміло; не питай «звідки ви про нас дізнались», якщо вже є ADS.',
  );
  return lines.join('\n');
}

export const ADS_ONLY_ORGANIC_HANDOFF_REASON =
  'Органічний DM (режим лише реклама CTD)';

export const ADS_ONLY_SLA_RESUME_HINT =
  '[Режим лише реклама] Це органічне звернення. Менеджер не відповів у SLA — тепер відповідай ти коротко й по суті.';

/** True when conversation sticky or this inbound message carries ADS/SHORTLINK referral. */
export function conversationHasAdAttribution(opts: {
  conversationReferral?: unknown;
  messageReferral?: IgAdReferral | null;
}): boolean {
  if (opts.messageReferral) return true;
  if (isAdsReferral(opts.conversationReferral)) return true;
  if (
    opts.conversationReferral
    && typeof opts.conversationReferral === 'object'
    && !Array.isArray(opts.conversationReferral)
  ) {
    const src = String((opts.conversationReferral as { source?: string }).source ?? '').toUpperCase();
    return src === 'ADS' || src === 'SHORTLINK' || src === 'IG_SHOPPING';
  }
  return false;
}

export function referralFromUnknown(value: unknown): IgAdReferral | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const source = typeof v.source === 'string' ? v.source.toUpperCase() : '';
  if (!source) return null;
  if (source !== 'ADS' && source !== 'SHORTLINK' && source !== 'IG_SHOPPING') return null;
  return {
    source,
    ...(typeof v.type === 'string' ? { type: v.type } : {}),
    ...(typeof v.adId === 'string' ? { adId: v.adId } : {}),
    ...(typeof v.ref === 'string' ? { ref: v.ref } : {}),
    ...(typeof v.adTitle === 'string' ? { adTitle: v.adTitle } : {}),
    ...(typeof v.photoUrl === 'string' ? { photoUrl: v.photoUrl } : {}),
    ...(typeof v.videoUrl === 'string' ? { videoUrl: v.videoUrl } : {}),
    capturedAt:
      typeof v.capturedAt === 'string' ? v.capturedAt : new Date().toISOString(),
  };
}
