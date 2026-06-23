/**
 * Direct AI Agents — analytics helpers.
 * GTM: GTM-P2VWLSFF · GA4: G-95B8KJJ8WT (gtag loaded in page head).
 */
(function () {
  'use strict';

  var GA_ID = 'G-95B8KJJ8WT';

  window.dataLayer = window.dataLayer || [];

  function gtag() {
    window.dataLayer.push(arguments);
  }
  if (typeof window.gtag !== 'function') {
    window.gtag = gtag;
  }

  function push(obj) {
    window.dataLayer.push(obj);
  }

  function gaEvent(name, params) {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params || {});
    }
  }

  function storedUtm() {
    try {
      var raw = sessionStorage.getItem('dal_utm');
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function captureUtm() {
    var params = new URLSearchParams(window.location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    var utm = {};
    var has = false;
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) {
        utm[k] = v;
        has = true;
      }
    });
    var gclid = params.get('gclid');
    if (gclid) {
      utm.gclid = gclid;
      has = true;
    }
    if (!has) return;
    push(Object.assign({ event: 'utm_params' }, utm));
    try {
      sessionStorage.setItem('dal_utm', JSON.stringify(utm));
    } catch (_) {}
  }

  window.dalAnalytics = {
    gaId: GA_ID,
    push: push,
    captureUtm: captureUtm,
    storedUtm: storedUtm,

    lead: function (data) {
      var payload = Object.assign({
        method: 'contact_form',
      }, storedUtm(), data || {});
      push(Object.assign({ event: 'generate_lead' }, payload));
      gaEvent('generate_lead', payload);
    },

    ctaClick: function (plan, location) {
      var payload = {
        cta_plan: plan || '',
        cta_location: location || 'unknown',
      };
      push(Object.assign({ event: 'cta_click' }, payload));
      gaEvent('cta_click', payload);
    },
  };

  captureUtm();
})();
