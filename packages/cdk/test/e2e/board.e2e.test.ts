// The web app in a real browser against the real router and DynamoDB Local: what a person does on the board, end to end.
// Chromium comes from Playwright's browser cache (CI installs it; PLAYWRIGHT_BROWSERS_PATH or CHROME point elsewhere).
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import type { LocalServer } from '../support/local-server.ts';
import { demoBoard } from './demo-board.ts';

let server: LocalServer;
let browser: Browser;
let page: Page;
const problems: string[] = [];

beforeAll(async () => {
  server = await demoBoard(inject('dynamodbEndpoint'));
  browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A console error or an uncaught exception anywhere in the run fails it: a CSP violation shows up as one.
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page: ${e.message}`));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const api = async (path: string): Promise<any> => (await fetch(`${server.url}/api/human${path}`)).json();
const cardByKey = async (key: string) => (await api(`/cards?key=${encodeURIComponent(key)}`)).cards[0];

describe('a person on the board', () => {
  test('the dashboard lists every project and flags the one that needs a person', async () => {
    await page.goto(server.url);
    const rows = page.locator('[data-project]');
    await expect.poll(() => rows.count()).toBe(4);
    await expect
      .poll(() => page.locator('[data-project="payments-platform"]').getAttribute('class'))
      .toContain('needs');
  });

  test('a project board shows each column and the stale, unread and reopened cards', async () => {
    await page.locator('[data-project="payments-platform"] a.project-name').click();
    await page.waitForURL('**/p/payments-platform');
    for (const col of ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'blocked']) {
      await expect.poll(() => page.locator(`[data-col="${col}"]`).count(), { message: col }).toBe(1);
    }
    await expect.poll(() => page.locator('.card[data-state="stale"]').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.card[data-unread="true"]').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.card[data-reopened="true"]').count()).toBeGreaterThan(0);
  });

  test('dragging a card to another column moves it on the board and in the store', async () => {
    const before = await cardByKey('acme/payments-api/error-codes');
    expect(before.column).toBe('backlog');
    const tile = page.locator(`[data-card-id="${before.id}"]`);
    const target = page.locator('[data-col="ready"]');
    const from = await tile.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error('tile or column not laid out');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
      const x = from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / 12;
      await page.mouse.move(x, to.y + 120);
    }
    await page.mouse.up();
    await expect.poll(async () => (await cardByKey('acme/payments-api/error-codes')).column).toBe('ready');
    await expect.poll(() => target.locator(`[data-card-id="${before.id}"]`).count()).toBe(1);
  });

  test('a comment from the drawer reaches the card and marks it unread for its agent', async () => {
    const card = await cardByKey('acme/payments-api/idempotent-charges');
    await page.locator(`[data-card-id="${card.id}"]`).click();
    const drawer = page.getByRole('dialog', { name: 'Card details' });
    await drawer.waitFor();
    await drawer.locator('textarea[placeholder^="Comment"]').fill('Use the request id as the key, not the amount.');
    await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => drawer.getByText('Use the request id as the key').count()).toBe(1);
    const after = await cardByKey('acme/payments-api/idempotent-charges');
    expect(after.unread).toBe(true);
    await drawer.getByRole('button', { name: 'Close card' }).click();
  });

  test('an admin adds an agent and sees its token once', async () => {
    await page.locator('nav[aria-label="Main"] a[href="/agents"]').click();
    await page.getByLabel('Name').fill('e2e runner');
    await page.getByRole('button', { name: 'Add agent and issue a token' }).click();
    const token = page.getByTestId('token');
    await token.waitFor();
    expect(await token.textContent()).toMatch(/^baton_[\w-]{40,}$/);
    await page.getByRole('button', { name: 'I have stored it' }).click();
    await expect.poll(() => page.locator('[data-agent="e2e-runner"]').count()).toBe(1);
    await expect.poll(() => page.locator('[data-agent="e2e-runner"]').getByText('expires in').count()).toBe(1);
  });

  test('nothing logged an error along the way', () => {
    expect(problems).toEqual([]);
  });
});
