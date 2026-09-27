import { defineConfig } from 'wxt';

// F12 Collector – WXT-Konfiguration für Chrome und Firefox (beide Manifest V3).
export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    return {
      name: 'F12 Collector',
      short_name: 'F12 Collector',
      description:
        'Exportiert alles aus den DevTools (DOM, Quellcode, Netzwerk, Styles, Speicher, Barrierefreiheit …) als ZIP – lokal, ohne Upload.',
      action: {
        default_title: 'F12 Collector',
        default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
      },
      permissions: [
        'cookies',
        'downloads',
        'storage',
        'scripting',
        'webRequest',
        ...(isFirefox ? ['webRequestBlocking', 'webRequestFilterResponse'] : ['debugger', 'offscreen']),
      ],
      host_permissions: ['<all_urls>'],
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'f12-collector@local',
                strict_min_version: '128.0',
                data_collection_permissions: { required: ['none'] },
              },
            },
          }
        : {}),
    };
  },
});
