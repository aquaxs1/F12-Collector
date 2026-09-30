// Entry point for data collection in the content script (runs in every frame).
import type { ContentCollectOptions, FrameData } from '../types';
import { serializeDocument } from './dom';
import { collectResources } from './resources';
import { collectStorage } from './storage';
import { collectStyles } from './styles';
import { collectA11y } from './a11y';
import { collectApplication } from './application';
import { errText } from './util';

export async function collectFrame(opts: ContentCollectOptions): Promise<Omit<FrameData, 'frameId'>> {
  const data: Omit<FrameData, 'frameId'> = {
    url: location.href,
    origin: location.origin,
    isTop: window.top === window,
    title: document.title,
    errors: [],
  };
  const step = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      data.errors.push(`${name}: ${errText(e)}`);
    }
  };
  if (opts.dom) await step('DOM', () => (data.dom = serializeDocument(document)));
  if (opts.resources) await step('Resources', () => (data.resources = collectResources()));
  if (opts.storage) await step('Storage', async () => (data.storage = await collectStorage(opts.indexedDbMaxRecords, opts.maxBodyBytes)));
  if (opts.styles) await step('Styles', async () => (data.styles = await collectStyles(opts)));
  if (opts.a11y) await step('Accessibility', () => (data.a11y = collectA11y()));
  if (opts.application) await step('Application', async () => (data.application = await collectApplication()));
  return data;
}
