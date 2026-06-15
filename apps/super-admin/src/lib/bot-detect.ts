/** Heuristic bot / link-preview crawler detection from User-Agent. */
const BOT_PATTERNS = [
  /bot\b/i,
  /crawl/i,
  /spider/i,
  /preview/i,
  /facebookexternalhit/i,
  /facebot/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /slackbot/i,
  /discordbot/i,
  /google-extended/i,
  /embedly/i,
  /quora link preview/i,
  /outbrain/i,
  /vkshare/i,
  /w3c_validator/i,
  /bingpreview/i,
  /applebot/i,
  /yandexbot/i,
  /pinterest/i,
  /redditbot/i,
  /ia_archiver/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /go-http-client/i,
  /java\//i,
  /headless/i,
  /phantomjs/i,
];

export function isLikelyBot(userAgent: string | undefined): boolean {
  if (!userAgent?.trim()) return true;
  return BOT_PATTERNS.some((re) => re.test(userAgent));
}

export function isLikelyPreviewBot(userAgent: string | undefined): boolean {
  if (!userAgent?.trim()) return false;
  return /preview|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot|embedly|bingpreview/i.test(
    userAgent,
  );
}
