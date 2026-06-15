import { config } from '../config.js';

export interface LeadEmailPayload {
  name?: string;
  email?: string;
  instagram?: string;
  messenger?: string;
  message?: string;
  plan?: string;
  lang?: string;
  pageUrl?: string;
  ref?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label: string, value: string | undefined): string {
  if (!value?.trim()) return '';
  return `<tr><td style="padding:8px 12px;color:#64748B;font-size:13px;vertical-align:top">${esc(label)}</td><td style="padding:8px 12px;color:#0F172A;font-size:14px">${esc(value.trim())}</td></tr>`;
}

export async function sendLeadEmail(payload: LeadEmailPayload): Promise<void> {
  if (!config.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const subjectParts = [
    payload.plan ? `[${payload.plan}]` : '[Lead]',
    payload.name || payload.instagram || payload.email || 'direct-ai-agents.com',
  ];

  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px">
      <h2 style="color:#4F46E5;margin:0 0 16px">Нова заявка з лендингу</h2>
      <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:8px">
        ${row('Імʼя / бренд', payload.name)}
        ${row('Email', payload.email)}
        ${row('Instagram', payload.instagram)}
        ${row('Мессенджер', payload.messenger)}
        ${row('Тариф / інтерес', payload.plan)}
        ${row('Мова', payload.lang)}
        ${row('Джерело (ref)', payload.ref)}
        ${row('Сторінка', payload.pageUrl)}
      </table>
      ${
        payload.message?.trim()
          ? `<p style="margin:16px 0 0;padding:12px;background:#EEF2FF;border-radius:8px;color:#0F172A;font-size:14px;line-height:1.5">${esc(payload.message.trim())}</p>`
          : ''
      }
    </div>
  `.trim();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.RESEND_FROM,
      to: [config.LANDING_CONTACT_TO],
      subject: subjectParts.join(' '),
      html,
      ...(payload.email?.trim() ? { reply_to: payload.email.trim() } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body.slice(0, 200)}`);
  }
}
