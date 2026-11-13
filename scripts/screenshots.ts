// The README's screenshots, taken from the demo board in Chromium so they show the app as it is built, not as it was drawn.
//   pnpm --filter @andrewchemis/baton-cdk run build:assets && node scripts/screenshots.ts
// Writes docs/images/*.png. Needs Java 17 or later (DynamoDB Local) and Chromium (Playwright's cache, or CHROME).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContextOptions, type Page } from 'playwright-core';
import { demoBoard } from '../packages/cdk/test/e2e/demo-board.ts';
import { root, startDynamoDbLocal } from './dynamodb-local.ts';

const out = join(root, 'docs', 'images');
mkdirSync(out, { recursive: true });

const ddb = await startDynamoDbLocal();
const server = await demoBoard(ddb.endpoint);
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

async function shoot(name: string, path: string, options: BrowserContextOptions, then?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  await page.goto(`${server.url}${path}`);
  await page.waitForLoadState('networkidle');
  if (then) await then(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await context.close();
  console.log(`docs/images/${name}.png`);
}

const desktop = { viewport: { width: 1440, height: 860 } };
await shoot('dashboard', '/', { ...desktop, colorScheme: 'light' });
await shoot('board-light', '/p/payments-platform', { ...desktop, colorScheme: 'light' });
await shoot('board-dark', '/p/payments-platform', { ...desktop, colorScheme: 'dark' });
await shoot('card-drawer', '/p/payments-platform', { ...desktop, colorScheme: 'light' }, async (page) => {
  await page.locator('.card[data-unread="true"]').first().click();
  await page.getByRole('dialog', { name: 'Card details' }).waitFor();
  await page.waitForLoadState('networkidle');
});
await shoot('board-phone', '/p/payments-platform', {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});

await browser.close();
await server.close();
ddb.stop();
