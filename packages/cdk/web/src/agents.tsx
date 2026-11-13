import { useState } from 'preact/hooks';
import { api } from './api.ts';
import { ErrorNote } from './error-note.tsx';
import { useAction, usePoll } from './hooks.ts';
import { notify } from './toast.tsx';
import type { AgentView } from './types.ts';
import { ago, span, when } from './util.ts';

/** How long a token has left, or that it has run out. */
function expiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return 'no expiry';
  return expiresAt <= now ? 'expired' : `expires in ${span(expiresAt - now)}`;
}

interface Issued {
  agentId: string;
  token: string;
}

export function Agents() {
  const agents = usePoll(() => api.get<{ agents: AgentView[] }>('/agents'), 'agents', 30_000);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const { busy, run: act } = useAction();

  const run = (fn: () => Promise<unknown>) =>
    act(async () => {
      await fn();
      await agents.reload();
    });
  const issueToken = async (agentId: string, label: string) => {
    const made = await api.post<{ token: string; agentId: string }>(`/agents/${agentId}/tokens`, { label });
    setIssued({ agentId: made.agentId, token: made.token });
  };

  return (
    <main class="page">
      <h1>Agents</h1>
      <p class="muted">
        An agent identity is who a claim is recorded against. Each token is shown once, stored here only as its hash,
        and works for 90 days or until you revoke it (within five minutes). Only the board's admins see this page.
      </p>

      {issued ? (
        <section class="panel token-box" aria-label="New token">
          <h2>Token for {issued.agentId}</h2>
          <p>This is the only time it is shown. Copy it now.</p>
          <pre class="token" data-testid="token">
            {issued.token}
          </pre>
          <p class="muted">Set it where the agent runs:</p>
          <pre class="snippet">{`export BATON_URL=${location.origin}\nexport BATON_TOKEN=${issued.token}`}</pre>
          <div class="actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.token).then(
                  () => notify('Token copied.', 'info'),
                  () => notify('Copy failed: select the token and copy it by hand.'),
                );
              }}
            >
              Copy token
            </button>
            <button type="button" class="plain" onClick={() => setIssued(null)}>
              I have stored it
            </button>
          </div>
        </section>
      ) : null}

      <ErrorNote text={agents.error} />
      <ul class="agents">
        {(agents.data?.agents ?? []).map((a) => (
          <li key={a.id} class="agent" data-agent={a.id}>
            <div class="agent-head">
              <h2 class="mono">{a.id}</h2>
              <span class="muted" title={when(a.createdAt)}>
                created {ago(a.createdAt)}
              </span>
              <span class="grow" />
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => issueToken(a.id, `token ${a.tokens.length + 1}`))}
              >
                New token
              </button>
              <button
                type="button"
                class="danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Delete ${a.id} and revoke its ${a.tokens.length} token(s)?`))
                    void run(() => api.del(`/agents/${a.id}`));
                }}
              >
                Delete
              </button>
            </div>
            <ul class="tokens">
              {a.tokens.map((t) => (
                <li key={t.tokenId}>
                  <span>{t.label}</span>
                  <span class="muted" title={when(t.createdAt)}>
                    {ago(t.createdAt)}
                  </span>
                  <span class="muted" title={t.expiresAt === null ? undefined : when(t.expiresAt)}>
                    {expiry(t.expiresAt)}
                  </span>
                  <button
                    type="button"
                    class="plain danger"
                    disabled={busy}
                    aria-label={`Revoke ${t.label} of ${a.id}`}
                    onClick={() => {
                      if (confirm(`Revoke "${t.label}"? Anything using it stops working within five minutes.`))
                        void run(() => api.del(`/agents/${a.id}/tokens/${t.tokenId}`));
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
              {a.tokens.length === 0 ? <li class="muted">No tokens. Issue one to let this agent in.</li> : null}
            </ul>
          </li>
        ))}
      </ul>

      <form
        class="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(async () => {
            const made = await api.post<{ agent: AgentView }>('/agents', { name });
            setName('');
            await issueToken(made.agent.id, 'first token');
          });
        }}
      >
        <h2>Add an agent</h2>
        <div class="row">
          <label class="field grow">
            Name
            <input
              value={name}
              onInput={(e) => setName(e.currentTarget.value)}
              maxLength={64}
              placeholder="for example laptop-claude"
              required
            />
          </label>
          <button type="submit" class="primary" disabled={busy || !name.trim()}>
            Add agent and issue a token
          </button>
        </div>
      </form>
    </main>
  );
}
