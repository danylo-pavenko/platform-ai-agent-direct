import { config } from '../config.js';

/** Deep link to view an order in the KeyCRM web app. */
export function keycrmOrderAppUrl(keycrmOrderId: string | number): string {
  const base = config.KEYCRM_APP_URL.replace(/\/$/, '');
  return `${base}/order/view/${keycrmOrderId}`;
}
