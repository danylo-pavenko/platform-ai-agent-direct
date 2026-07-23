import { createApp } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import { setup } from './setup.js';

const templateRes = await fetch('/templates/app.html', { cache: 'no-cache' });
if (!templateRes.ok) {
  document.body.innerHTML = `<pre style="color:#ef4444;padding:24px">Failed to load Super Admin template (${templateRes.status})</pre>`;
  throw new Error(`templates/app.html HTTP ${templateRes.status}`);
}
const template = await templateRes.text();

createApp({ template, setup }).mount('#app');
