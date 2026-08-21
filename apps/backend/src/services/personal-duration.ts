/**
 * Apply personal CRM-history duration to booking service lines.
 */

import pino from 'pino';
import {
  formatRecommendedDurationLine,
  resolveRecommendedDuration,
  type RecommendedDuration,
} from '../lib/client-service-duration.js';
import { fetchClientCrmHistory } from './client-crm-link.js';

const log = pino({ name: 'personal-duration' });

export type DurationServiceLine = {
  id: string;
  durationMin: number;
  masterId?: string;
  name?: string;
};

export type ApplyPersonalDurationResult = {
  services: DurationServiceLine[];
  notes: string[];
  recommendations: RecommendedDuration[];
};

/**
 * When clientId is set and CRM history has similar visits, override durationMin.
 */
export async function applyPersonalDurations(opts: {
  clientId?: string | null;
  services: DurationServiceLine[];
}): Promise<ApplyPersonalDurationResult> {
  const services = opts.services.map((s) => ({ ...s }));
  if (!opts.clientId || services.length === 0) {
    return { services, notes: [], recommendations: [] };
  }

  let visits;
  try {
    const history = await fetchClientCrmHistory(opts.clientId, { limit: 15 });
    visits = history.items;
  } catch (err) {
    log.warn({ err, clientId: opts.clientId }, 'personal duration: history fetch failed');
    return { services, notes: [], recommendations: [] };
  }

  if (!visits || visits.length === 0) {
    return { services, notes: [], recommendations: [] };
  }

  const notes: string[] = [];
  const recommendations: RecommendedDuration[] = [];

  for (const svc of services) {
    const rec = resolveRecommendedDuration({
      catalogDurationMin: svc.durationMin,
      serviceId: svc.id,
      serviceName: svc.name,
      masterId: svc.masterId,
      visits,
    });
    recommendations.push(rec);
    if (rec.source === 'catalog') continue;
    if (rec.durationMin === svc.durationMin) {
      notes.push(formatRecommendedDurationLine(rec));
      continue;
    }
    log.info(
      {
        clientId: opts.clientId,
        serviceId: svc.id,
        from: svc.durationMin,
        to: rec.durationMin,
        source: rec.source,
        sampleCount: rec.sampleCount,
      },
      'personal duration applied',
    );
    svc.durationMin = rec.durationMin;
    notes.push(formatRecommendedDurationLine(rec));
  }

  return { services, notes: [...new Set(notes)], recommendations };
}
