import { browser } from 'wxt/browser';

// Own "F12 Collector" tab in DevTools (F12).
browser.devtools.panels.create('F12 Collector', '/icon/32.png', '/devtools-panel.html');
