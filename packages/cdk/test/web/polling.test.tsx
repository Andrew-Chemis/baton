// usePoll: an answer identical to the one on screen leaves the data object alone, and a tick waits for the request before it.
import { afterEach, describe, expect, test } from 'vitest';
import { usePoll } from '../../web/src/hooks.ts';
import { mount, settle } from './support.tsx';

afterEach(() => document.body.replaceChildren());

function Probe(props: { load: () => Promise<{ n: number }>; seen: object[]; ms: number }) {
  const polled = usePoll(props.load, 'probe', props.ms);
  if (polled.data) props.seen.push(polled.data);
  return <p>{polled.data ? polled.data.n : '…'}</p>;
}

describe('usePoll', () => {
  test('an unchanged answer is not new data, but a changed one is', async () => {
    const seen: object[] = [];
    let n = 1;
    await mount(<Probe load={async () => ({ n })} seen={seen} ms={15} />);
    await settle(120);
    expect(new Set(seen).size).toBe(1);
    n = 2;
    await settle(60);
    expect(new Set(seen).size).toBe(2);
  });

  test('a tick is skipped while the last request is still out', async () => {
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 120));
      return { n: calls };
    };
    await mount(<Probe load={slow} seen={[]} ms={10} />);
    await settle(200);
    // Ticks every 10 ms for 200 ms would start about twenty requests if each did not wait for the one before.
    expect(calls).toBeLessThanOrEqual(3);
  });
});
