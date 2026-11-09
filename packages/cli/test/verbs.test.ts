// Requirement 8.1 and 8.2: each verb prints JSON, the repo/worktree/branch come from the checkout, and the project from the
// repo map. These run against the real service over DynamoDB Local.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO, startWorld, type World } from './harness.ts';

let w: World;
let checkout: string;
beforeAll(async () => {
  w = await startWorld();
  checkout = w.repo();
});
afterAll(async () => w.close());

const human = () => w.board.as({ human: 'owner@example.test' });

describe('project register', () => {
  test('creates the project for this checkout, and registering again changes nothing', async () => {
    const first = await w.baton(['project', 'register', '--name', 'Widgets'], { cwd: checkout });
    expect(first.code).toBe(0);
    expect(first.json.created).toBe(true);
    expect(first.json.project.repos).toEqual([REPO]);
    const again = await w.baton(['project', 'register', '--name', 'widgets'], { cwd: checkout });
    expect(again.code).toBe(0);
    expect(again.json.created).toBe(false);
    expect(again.json.added).toEqual([]);
  });

  test('a repo that belongs to another project is refused with that project named', async () => {
    const other = await w.baton(['project', 'register', '--name', 'Elsewhere'], { cwd: checkout });
    expect(other.code).toBe(1);
    expect(other.error.code).toBe('repo_taken');
    expect(other.error.project.name).toBe('Widgets');
    expect(other.error.message).toMatch(/Widgets/);
  });

  test('adds a second repo to the project of that name', async () => {
    const added = await w.baton(['project', 'register', '--name', 'Widgets', '--repo', 'acme/gadgets']);
    expect(added.code).toBe(0);
    expect(added.json.project.repos.toSorted()).toEqual(['acme/gadgets', REPO]);
  });
});

describe('the card verbs', () => {
  let id: string;

  test('create prints the card; the same key again returns it unchanged', async () => {
    const made = await w.baton(
      ['create', '--title', 'Fix login', '--key', 'fix-login', '--body', 'It fails on Safari.', '--column', 'ready'],
      {
        cwd: checkout,
      },
    );
    expect(made.code).toBe(0);
    expect(made.json.card).toMatchObject({ title: 'Fix login', key: `${REPO}/fix-login`, column: 'ready', repo: REPO });
    id = made.json.card.id;
    const again = await w.baton(['create', '--title', 'Fix login', '--key', 'fix-login'], { cwd: checkout });
    expect(again.json.created).toBe(false);
    expect(again.json.card.id).toBe(id);
  });

  test("list shows this repo's open cards under the project it resolved", async () => {
    await w.baton(['create', 'Old thing', '--key', 'old-thing', '--column', 'done'], { cwd: checkout });
    const open = await w.baton(['list'], { cwd: checkout });
    expect(open.json.project.name).toBe('Widgets');
    expect(open.json.cards.map((c: any) => c.key)).toEqual([`${REPO}/fix-login`]);
    const all = await w.baton(['list', '--all'], { cwd: checkout });
    expect(all.json.cards).toHaveLength(2);
    const done = await w.baton(['list', '--column', 'done'], { cwd: checkout });
    expect(done.json.cards.map((c: any) => c.key)).toEqual([`${REPO}/old-thing`]);
  });

  test("take by slug claims with the checkout's repo, worktree and branch, and moves the card to In progress", async () => {
    const taken = await w.baton(['take', 'fix-login'], { cwd: checkout });
    expect(taken.code).toBe(0);
    expect(taken.json.card.column).toBe('in_progress');
    expect(taken.json.card.claim).toMatchObject({ repo: REPO, worktree: checkout, branch: 'main', agentId: w.agentId });
    expect(taken.json.card.claim.session).toMatch(/^local-/);
    expect(taken.json.alreadyHeld).toBe(false);
    expect(taken.json.heartbeatSeconds).toBe(60);
  });

  test('taking it again from the same worktree is a no-op', async () => {
    const again = await w.baton(['take', id], { cwd: checkout });
    expect(again.code).toBe(0);
    expect(again.json.alreadyHeld).toBe(true);
    const events = await human().get(`/cards/${id}/events`);
    expect(events.body.events.filter((e: any) => e.type === 'claimed')).toHaveLength(1);
  });

  test('heartbeat uses the card this worktree holds when none is named', async () => {
    const beat = await w.baton(['heartbeat'], { cwd: checkout });
    expect(beat.code).toBe(0);
    expect(beat.json.card.id).toBe(id);
    expect(beat.json.leaseSeconds).toBe(600);
  });

  test('a human comment shows up as unread; check lists it; pass is refused until it is acknowledged', async () => {
    await human().post(`/cards/${id}/comments`, { text: 'Please also cover the iOS app.' });
    const attention = await w.baton(['check'], { cwd: checkout });
    expect(attention.json.cards.map((c: any) => c.id)).toEqual([id]);
    expect(attention.json.cards[0].unread).toBe(true);

    const refused = await w.baton(['pass'], { cwd: checkout });
    expect(refused.code).toBe(1);
    expect(refused.error.code).toBe('unacked_comments');
    expect(refused.error.message).toMatch(/baton check/);
    expect(refused.error.message).toMatch(/baton ack/);

    const noCheck = await w.baton(['ack'], { cwd: checkout });
    expect(noCheck.code).toBe(1);
    expect(noCheck.error.code).toBe('nothing_checked');

    const checked = await w.baton(['check', id], { cwd: checkout });
    expect(checked.json.pending).toHaveLength(1);
    expect(checked.json.pending[0].payload.text).toBe('Please also cover the iOS app.');
    expect(checked.json.next).toMatch(/baton ack/);

    const acked = await w.baton(['ack'], { cwd: checkout });
    expect(acked.code).toBe(0);
    expect(acked.json.card.unread).toBe(false);
  });

  test('ack acknowledges what check showed, not what arrived after', async () => {
    await w.baton(['check', id], { cwd: checkout });
    await human().post(`/cards/${id}/comments`, { text: 'One more thing, added after you looked.' });
    // The recorded sequence is from before the new comment, so the card stays unread.
    const acked = await w.baton(['ack'], { cwd: checkout });
    expect(acked.code).toBe(0);
    expect(acked.json.card.unread).toBe(true);
    const pass = await w.baton(['pass'], { cwd: checkout });
    expect(pass.error.code).toBe('unacked_comments');
    await w.baton(['check', id], { cwd: checkout });
    await w.baton(['ack'], { cwd: checkout });
  });

  test('comment, then pass releases the card to In review and forgets it', async () => {
    const note = await w.baton(['comment', 'fix-login', 'Reproduced on Safari 19; fix is in', 'the cookie parser.'], {
      cwd: checkout,
    });
    expect(note.code).toBe(0);
    expect(note.json.event.payload.text).toBe('Reproduced on Safari 19; fix is in the cookie parser.');
    const passed = await w.baton(['pass', '--comment', 'Ready for review.'], { cwd: checkout });
    expect(passed.code).toBe(0);
    expect(passed.json.card).toMatchObject({ column: 'in_review', claim: null });
    expect(passed.json.card.lastClaim).toMatchObject({ endedBy: 'released', reason: 'done' });
    const none = await w.baton(['heartbeat'], { cwd: checkout });
    expect(none.code).toBe(1);
    expect(none.error.code).toBe('no_card');
  });

  test('drop releases in place with a reason, and rejects session_ended', async () => {
    const second = await w.baton(['create', 'Add dark mode', '--key', 'dark-mode', '--column', 'ready'], {
      cwd: checkout,
    });
    const key = second.json.card.key;
    await w.baton(['take', key], { cwd: checkout });
    const bad = await w.baton(['drop', '--reason', 'session_ended'], { cwd: checkout });
    expect(bad.code).toBe(2);
    expect(bad.error.code).toBe('usage');
    const dropped = await w.baton(['drop', '--reason', 'blocked', '--comment', 'Waiting on the design tokens.'], {
      cwd: checkout,
    });
    expect(dropped.code).toBe(0);
    expect(dropped.json.card).toMatchObject({ column: 'in_progress', claim: null, state: 'unowned' });
    expect(dropped.json.card.lastClaim.reason).toBe('blocked');
  });

  test('move sends the worktree and moves a card the agent does not hold', async () => {
    const third = await w.baton(['create', 'Tidy the docs', '--key', 'tidy-docs'], { cwd: checkout });
    const moved = await w.baton(['move', third.json.card.key, '--to', 'ready'], { cwd: checkout });
    expect(moved.code).toBe(0);
    expect(moved.json.card.column).toBe('ready');
  });

  test('a card in another repo is named in the refusal', async () => {
    await human().post('/cards', { repo: 'acme/gadgets', title: 'Gadget thing', key: 'gadget-thing' });
    const mismatch = await w.baton(['take', 'acme/gadgets/gadget-thing'], { cwd: checkout });
    expect(mismatch.code).toBe(1);
    expect(mismatch.error.code).toBe('repo_mismatch');
    expect(mismatch.error.message).toMatch(/acme\/gadgets/);
  });

  test('an unknown slug says how to find the right one', async () => {
    const missing = await w.baton(['take', 'no-such-card'], { cwd: checkout });
    expect(missing.code).toBe(1);
    expect(missing.error.code).toBe('not_found');
    expect(missing.error.message).toMatch(/baton list/);
  });
});
