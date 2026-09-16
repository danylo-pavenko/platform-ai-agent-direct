import { computed } from 'vue';
import { useDisplay } from 'vuetify';

/**
 * Touch-friendly Vuetify density: comfortable on mobile, compact on desktop.
 */
export function useTouchDensity() {
  const { mobile } = useDisplay();
  const density = computed(() => (mobile.value ? 'comfortable' : 'compact'));
  return { mobile, density };
}
