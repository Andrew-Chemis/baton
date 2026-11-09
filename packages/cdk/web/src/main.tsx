import { render } from 'preact';
import { App, applyTheme, savedTheme } from './app.tsx';
import { setApiConfig } from './api.ts';
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect
import './styles.css';
import type { AppConfig } from './types.ts';

applyTheme(savedTheme());
const root = document.getElementById('app') as HTMLElement;

async function start(): Promise<void> {
  let config: AppConfig;
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    config = (await response.json()) as AppConfig;
  } catch {
    root.textContent =
      'The board could not load its settings (config.json). Reload the page; if it persists, the deployment is incomplete.';
    return;
  }
  setApiConfig(config);
  render(<App config={config} />, root);
}

void start();
