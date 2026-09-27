import { mountApp } from '@/lib/ui/app';
import { browser } from 'wxt/browser';

mountApp(document.getElementById('app')!, {
  kind: 'devtools',
  async getTabId() {
    return browser.devtools.inspectedWindow.tabId;
  },
});
