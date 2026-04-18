import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import './styles/global.css';

import App from './App.vue';
import router from './router';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        dark: false,
        colors: {
          background: '#f6f9fc',
          surface: '#ffffff',
          'surface-variant': '#eef2f6',
          primary: '#635bff',
          'primary-darken-1': '#4b45c6',
          secondary: '#0a2540',
          accent: '#00d4aa',
          error: '#df1b41',
          warning: '#f5a623',
          info: '#0a5cff',
          success: '#0d9668',
          'on-background': '#0a2540',
          'on-surface': '#0a2540',
        },
        variables: {
          'border-color': '#e6ebf1',
          'border-opacity': 1,
          'high-emphasis-opacity': 0.92,
          'medium-emphasis-opacity': 0.58,
          'disabled-opacity': 0.38,
        },
      },
    },
  },
  defaults: {
    VCard: {
      elevation: 0,
      border: true,
      rounded: 'xl',
    },
    VBtn: {
      rounded: 'lg',
      elevation: 0,
    },
    VTextField: {
      variant: 'outlined',
      density: 'compact',
      rounded: 'lg',
    },
    VTextarea: {
      variant: 'outlined',
      density: 'compact',
      rounded: 'lg',
    },
    VSelect: {
      variant: 'outlined',
      density: 'compact',
      rounded: 'lg',
    },
    VChip: {
      rounded: 'lg',
    },
    VDataTable: {
      hover: true,
    },
  },
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(vuetify);
app.mount('#app');
