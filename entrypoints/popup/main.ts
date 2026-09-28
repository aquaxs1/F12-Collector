import { mountApp } from '@/lib/ui/app';
import { browser } from 'wxt/browser';

mountApp(document.getElementById('app')!, {
  kind: 'popup',
  async getTabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  },
});
