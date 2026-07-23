import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js';
import { BASE, CHART_TZ, emptyLinkForm } from '../constants.js';

export function createLinks(deps) {
  const {
    links,
    linkModal,
    linkStats,
    linkChartCanvas,
    authHeaders,
    headers,
    logout,
    nextTick,
  } = deps;

  let linkChartInstance = null;

  const totalHumanClicks = computed(() =>
    links.value.reduce((sum, l) => sum + linkHumanClicks(l), 0),
  );
  const totalFormSubmissions = computed(() =>
    links.value.reduce((sum, l) => sum + linkFormSubmissions(l), 0),
  );

  function linkStat(l, key) {
    const stats = l && l.stats;
    if (!stats || stats[key] == null) return 0;
    return stats[key];
  }

  function linkHumanClicks(l) { return linkStat(l, 'humanClicks'); }
  function linkRawClicks(l) { return linkStat(l, 'rawClicks'); }
  function linkFormSubmissions(l) { return linkStat(l, 'formSubmissions'); }

  function linkCountryEntries(l) {
    const countries = (l && l.stats && l.stats.countries) || null;
    if (!countries) return [];
    return Object.keys(countries).map((country) => ({ country, count: countries[country] }));
  }

  function linkCountryCount(l) { return linkCountryEntries(l).length; }

  function linkActiveClass(l) { return l.isActive ? 'badge-active' : 'badge-suspended'; }
  function linkActiveLabel(l) { return l.isActive ? 'on' : 'paused'; }

  async function loadLinks() {
    try {
      const r = await fetch(`${BASE}/links`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      links.value = await r.json();
    } catch (e) {
      console.error('loadLinks failed:', e);
      links.value = [];
    }
  }

  function openLinkModal(l) {
    if (l) {
      linkModal.editing = l.id;
      linkModal.form = { name: l.name, slug: l.slug, destinationUrl: l.destinationUrl };
    } else {
      linkModal.editing = null;
      linkModal.form = emptyLinkForm();
    }
    linkModal.open = true;
  }

  async function saveLink() {
    if (!linkModal.form.name.trim()) {
      alert('Вкажіть назву');
      return;
    }
    linkModal.saving = true;
    try {
      const payload = {
        name: linkModal.form.name.trim(),
        ...(linkModal.form.slug.trim() ? { slug: linkModal.form.slug.trim().toLowerCase() } : {}),
        ...(linkModal.form.destinationUrl.trim() ? { destinationUrl: linkModal.form.destinationUrl.trim() } : {}),
      };
      const url = linkModal.editing ? `${BASE}/links/${linkModal.editing}` : `${BASE}/links`;
      const method = linkModal.editing ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers: headers(), body: JSON.stringify(payload) });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error || 'Помилка збереження');
        return;
      }
      linkModal.open = false;
      await loadLinks();
    } finally {
      linkModal.saving = false;
    }
  }

  async function toggleLink(l) {
    await fetch(`${BASE}/links/${l.id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ isActive: !l.isActive }),
    });
    await loadLinks();
  }

  async function deleteLink(l) {
    if (!confirm('Видалити посилання «' + l.name + '»? Статистика кліків теж зникне.')) return;
    try {
      const r = await fetch(`${BASE}/links/${l.id}`, { method: 'DELETE', headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error || ('Помилка видалення (HTTP ' + r.status + ')'));
        return;
      }
      await loadLinks();
    } catch (e) {
      alert('Помилка мережі при видаленні');
      console.error('deleteLink failed:', e);
    }
  }

  function destroyLinkChart() {
    if (linkChartInstance) {
      linkChartInstance.destroy();
      linkChartInstance = null;
    }
  }

  function formatChartTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('uk-UA', {
      timeZone: CHART_TZ,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatChartLabel(iso, bucket) {
    const d = new Date(iso);
    if (bucket === 'day') {
      return d.toLocaleDateString('uk-UA', { timeZone: CHART_TZ, day: '2-digit', month: '2-digit' });
    }
    return d.toLocaleString('uk-UA', {
      timeZone: CHART_TZ,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function renderLinkChart() {
    destroyLinkChart();
    const canvas = linkChartCanvas.value;
    if (!canvas || !window.Chart) return;

    const points = linkStats.points;
    const labels = points.map((p) => formatChartLabel(p.t, linkStats.bucket));
    const datasets = [];

    if (linkStats.metric === 'both' || linkStats.metric === 'human') {
      datasets.push({
        label: 'Люди',
        data: points.map((p) => p.human),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.15)',
        fill: true,
        tension: 0.25,
        pointRadius: points.length > 48 ? 0 : 3,
      });
    }
    if (linkStats.metric === 'both' || linkStats.metric === 'all') {
      datasets.push({
        label: 'Всі кліки',
        data: points.map((p) => p.total),
        borderColor: '#7c6eff',
        backgroundColor: 'rgba(124,110,255,0.1)',
        fill: linkStats.metric === 'all',
        tension: 0.25,
        pointRadius: points.length > 48 ? 0 : 3,
      });
    }

    linkChartInstance = new window.Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#e8e8f0' } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const idx = items[0] && items[0].dataIndex;
                if (idx == null || !points[idx]) return '';
                return formatChartTime(points[idx].t);
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: '#6b6b8a',
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: linkStats.bucket === 'hour' ? 24 : 14,
            },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#6b6b8a', precision: 0 },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
        },
      },
    });
  }

  async function loadLinkTimeline() {
    if (!linkStats.link) return;
    linkStats.loading = true;
    linkStats.error = '';
    destroyLinkChart();
    try {
      const qs = '?bucket=' + encodeURIComponent(linkStats.bucket) + '&days=' + encodeURIComponent(String(linkStats.days));
      const r = await fetch(`${BASE}/links/${linkStats.link.id}/timeline${qs}`, { headers: authHeaders() });
      if (r.status === 401) { logout(); return; }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        linkStats.error = err.error || ('HTTP ' + r.status);
        return;
      }
      const data = await r.json();
      linkStats.points = data.points || [];
      linkStats.summary = data.summary || null;
      linkStats.loading = false;
      await nextTick();
      renderLinkChart();
    } catch (e) {
      linkStats.error = 'Помилка завантаження графіка';
      console.error('loadLinkTimeline failed:', e);
    } finally {
      linkStats.loading = false;
    }
  }

  async function openLinkStats(l) {
    linkStats.link = { id: l.id, name: l.name, slug: l.slug };
    linkStats.bucket = 'hour';
    linkStats.days = 14;
    linkStats.metric = 'both';
    linkStats.points = [];
    linkStats.summary = null;
    linkStats.error = '';
    linkStats.open = true;
    await loadLinkTimeline();
  }

  function closeLinkStats() {
    linkStats.open = false;
    destroyLinkChart();
    linkStats.link = null;
  }

  return {
    totalHumanClicks,
    totalFormSubmissions,
    linkHumanClicks,
    linkRawClicks,
    linkFormSubmissions,
    linkCountryEntries,
    linkCountryCount,
    linkActiveClass,
    linkActiveLabel,
    loadLinks,
    openLinkModal,
    saveLink,
    toggleLink,
    deleteLink,
    openLinkStats,
    closeLinkStats,
    loadLinkTimeline,
    renderLinkChart,
    formatChartTime,
  };
}
