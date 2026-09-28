import { browser } from 'wxt/browser';

// Eigener Tab "F12 Collector" in den DevTools (F12).
browser.devtools.panels.create('F12 Collector', '/icon/32.png', '/devtools-panel.html');
