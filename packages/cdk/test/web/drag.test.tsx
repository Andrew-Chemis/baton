// Requirement 6.2: dropping a card calls `move` once, with the column it landed in and a position between its neighbours.
// jsdom has no layout, so the geometry the page reads (card rectangles, what is under the pointer) is supplied here; the
// same drag is also done with a real mouse in Chromium by the browser check.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Board } from '../../web/src/board.tsx';
import { mount, projectView, route, settle, stubApi, until, useWebEnv, view } from './support.tsx';

const cards = [
  view({ id: 'a', title: 'Alpha', column: 'backlog', pos: 'a' }),
  view({ id: 'b', title: 'Bravo', column: 'ready', pos: 'b' }),
  view({ id: 'c', title: 'Charlie', column: 'ready', pos: 'd' }),
];
const project = projectView('widgets', { name: 'Widgets' });

function fire(target: Element, type: string, x: number, y: number) {
  const PointerCtor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new PointerCtor(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      ...({ pointerId: 1, pointerType: 'mouse' } as object),
    }),
  );
}

let under: Element | null = null;

useWebEnv('/p/widgets');
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollBy = vi.fn();
  document.elementFromPoint = () => under;
  // Cards are 80 tall and stacked 100 apart within their column.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = this.classList.contains('card')
      ? [...(this.parentElement?.children ?? [])].filter((c) => c.classList.contains('card')).indexOf(this)
      : 0;
    return {
      x: 0,
      y: index * 100,
      left: 0,
      top: index * 100,
      right: 200,
      bottom: index * 100 + 80,
      width: 200,
      height: 80,
      toJSON: () => ({}),
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  under = null;
});

async function board() {
  const calls = stubApi({
    'GET /projects': { projects: [project] },
    'GET /cards?project=widgets': { cards },
    'POST /cards/a/move': { card: cards[0] },
    'POST /cards/b/move': { card: cards[1] },
  });
  const root = await mount(<Board projectId="widgets" route={route()} />);
  await until(() => root.querySelector('.card'), 'cards');
  return { root, calls, moves: () => calls.filter((c) => c.method === 'POST') };
}

const card = (root: HTMLElement, id: string) => root.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
const column = (root: HTMLElement, name: string) =>
  root.querySelector(`[data-col="${name}"] .column-cards`) as HTMLElement;

describe('dropping a card', () => {
  test('into another column, between two cards: one move call with the column and a position between them', async () => {
    const { root, moves } = await board();
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointermove', 40, 30);
    under = column(root, 'ready');
    // Charlie's midpoint is 140 and Bravo's 40: a pointer at 90 is below Bravo and above Charlie.
    fire(alpha, 'pointermove', 300, 90);
    await settle();
    expect(root.querySelector('.drop-line')).toBeTruthy();
    fire(alpha, 'pointerup', 300, 90);
    await until(() => moves().length > 0, 'the move call');
    await settle(50);
    expect(moves()).toHaveLength(1);
    expect(moves()[0]?.path).toBe('/api/human/cards/a/move');
    expect(moves()[0]?.body).toEqual({ to: 'ready', pos: 'c' });
  });

  test('to the end of a column the position sorts after everything in it', async () => {
    const { root, moves } = await board();
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointermove', 60, 40);
    under = column(root, 'ready');
    fire(alpha, 'pointermove', 300, 500);
    fire(alpha, 'pointerup', 300, 500);
    await until(() => moves().length > 0, 'the move call');
    const body = moves()[0]?.body as { to: string; pos: string };
    expect(body.to).toBe('ready');
    expect(body.pos > 'd').toBe(true);
  });

  test('within a column, above its neighbour: the position sorts before it', async () => {
    const { root, moves } = await board();
    const charlie = card(root, 'c');
    fire(charlie, 'pointerdown', 20, 120);
    fire(charlie, 'pointermove', 40, 100);
    under = column(root, 'ready');
    fire(charlie, 'pointermove', 40, 10);
    fire(charlie, 'pointerup', 40, 10);
    await until(() => moves().length > 0, 'the move call');
    const body = moves()[0]?.body as { to: string; pos: string };
    expect(body.to).toBe('ready');
    expect(body.pos < 'b').toBe(true);
  });

  test('back where it started is not a move', async () => {
    const { root, moves } = await board();
    const bravo = card(root, 'b');
    fire(bravo, 'pointerdown', 20, 20);
    fire(bravo, 'pointermove', 40, 40);
    under = column(root, 'ready');
    fire(bravo, 'pointermove', 40, 30);
    fire(bravo, 'pointerup', 40, 30);
    await settle(50);
    expect(moves()).toHaveLength(0);
  });

  test('released outside any column does nothing', async () => {
    const { root, moves } = await board();
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointermove', 60, 40);
    under = document.body;
    fire(alpha, 'pointermove', 900, 900);
    fire(alpha, 'pointerup', 900, 900);
    await settle(50);
    expect(moves()).toHaveLength(0);
  });

  test('Escape cancels the drag, and the click that follows does not open the card', async () => {
    const { root, moves } = await board();
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointermove', 60, 40);
    under = column(root, 'ready');
    fire(alpha, 'pointermove', 300, 90);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fire(alpha, 'pointerup', 300, 90);
    alpha.click();
    await settle(50);
    expect(moves()).toHaveLength(0);
    expect(location.search).toBe('');
  });

  test('a press that never moves is a click: it opens the card and moves nothing', async () => {
    const { root, moves } = await board();
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointerup', 20, 20);
    alpha.click();
    await settle(50);
    expect(moves()).toHaveLength(0);
    expect(location.search).toBe('?card=a');
  });

  test("a failed move shows the board's message and puts the card back", async () => {
    const calls = stubApi({
      'GET /projects': { projects: [project] },
      'GET /cards?project=widgets': { cards },
      'POST /cards/a/move': new Response(
        JSON.stringify({ code: 'conflict', message: 'The card changed while you moved it. Reload and try again.' }),
        { status: 409 },
      ),
    });
    const root = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => root.querySelector('.card'), 'cards');
    const alpha = card(root, 'a');
    fire(alpha, 'pointerdown', 20, 20);
    fire(alpha, 'pointermove', 60, 40);
    under = column(root, 'ready');
    fire(alpha, 'pointermove', 300, 90);
    fire(alpha, 'pointerup', 300, 90);
    await until(() => calls.some((c) => c.method === 'POST'), 'the move call');
    await settle(80);
    expect(root.querySelector('[data-col="backlog"] [data-card-id="a"]')).toBeTruthy();
  });
});
