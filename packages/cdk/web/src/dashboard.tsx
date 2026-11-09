import { useState } from 'preact/hooks';
import { api, messageOf } from './api.ts';
import { ICON, type BadgeKind } from './badges.tsx';
import { COUNT_KINDS } from './counts.ts';
import { ErrorNote } from './error-note.tsx';
import { usePoll } from './hooks.ts';
import { Link, navigate } from './router.tsx';
import type { ProjectCounts, ProjectView } from './types.ts';
import { ago, when } from './util.ts';

const needsPerson = (c: ProjectCounts | undefined): boolean => (c ? c.stale + c.unowned + c.reopened > 0 : false);

/** Projects that need a person first, then the most recently active. */
export function ordered(projects: ProjectView[]): ProjectView[] {
  return projects.toSorted(
    (a, b) =>
      Number(needsPerson(b.counts)) - Number(needsPerson(a.counts)) ||
      b.lastEventAt - a.lastEventAt ||
      a.name.localeCompare(b.name),
  );
}

function Chip(props: { kind: BadgeKind; n: number }) {
  return (
    <li class={`chip ${props.kind}${props.n ? '' : ' zero'}`} data-count={props.kind}>
      {ICON[props.kind]}
      <span class="chip-n">{props.n}</span> <span class="chip-label">{props.kind}</span>
    </li>
  );
}

export function Dashboard() {
  const projects = usePoll(() => api.get<{ projects: ProjectView[] }>('/projects'), 'dashboard');
  const list = ordered(projects.data?.projects ?? []);
  return (
    <main class="page">
      <h1>Projects</h1>
      <ErrorNote text={projects.error} />
      {projects.data && list.length === 0 ? (
        <p class="empty-state">
          No projects yet. Register one below, or run <code>baton project register --name "..."</code> from a checkout.
        </p>
      ) : null}
      <ul class="projects">
        {list.map((p) => {
          const needs = needsPerson(p.counts);
          const c = p.counts;
          return (
            <li key={p.id} class={`project-row${needs ? ' needs' : ''}`} data-project={p.id}>
              <div class="project-main">
                <div class="project-line">
                  <Link href={`/p/${encodeURIComponent(p.id)}`} class="project-name">
                    {p.name}
                  </Link>
                  {needs ? <span class="needs-tag">Needs you</span> : null}
                </div>
                <div class="repo-pills">
                  {p.repos.map((r) => (
                    <span key={r} class="repo-pill">
                      {r}
                    </span>
                  ))}
                  {p.repos.length === 0 ? <span class="muted">no repos</span> : null}
                </div>
              </div>
              {c ? (
                <ul class="counts" aria-label={`${p.name} summary`}>
                  {COUNT_KINDS.map((kind) => (
                    <Chip key={kind} kind={kind} n={c[kind]} />
                  ))}
                </ul>
              ) : null}
              <div class="last">
                <time dateTime={new Date(p.lastEventAt).toISOString()} title={when(p.lastEventAt)}>
                  {ago(p.lastEventAt)}
                </time>
                {c ? <span class="muted">{c.total} cards</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <RegisterForm onRegistered={() => projects.reload()} />
    </main>
  );
}

function RegisterForm(props: { onRegistered: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [repos, setRepos] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: Event) => {
    event.preventDefault();
    const list = repos.split(/[\s,]+/).filter(Boolean);
    if (!name.trim() || list.length === 0) {
      setProblem('Give the project a name and at least one repo.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.post<{ project: ProjectView }>('/projects', { name, repos: list });
      setName('');
      setRepos('');
      await props.onRegistered();
      navigate(`/p/${encodeURIComponent(made.project.id)}`);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="panel register" onSubmit={submit}>
      <h2>Register a project</h2>
      <p class="muted">A project is a board for one or more repos. A repo belongs to one project.</p>
      <label class="field">
        Name
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} required />
      </label>
      <label class="field">
        Repos
        <textarea
          value={repos}
          onInput={(e) => setRepos(e.currentTarget.value)}
          rows={3}
          placeholder={'owner/name\nor a clone URL, one per line'}
        />
      </label>
      <ErrorNote text={problem} />
      <div class="actions">
        <button type="submit" class="primary" disabled={busy}>
          Register project
        </button>
      </div>
    </form>
  );
}
