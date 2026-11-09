import { useState } from 'preact/hooks';
import { api, messageOf } from './api.ts';
import { navigate } from './router.tsx';
import { notify } from './toast.tsx';
import type { ProjectView } from './types.ts';

export function ProjectSettings(props: { project: ProjectView; onChanged: () => void }) {
  const { project } = props;
  const [name, setName] = useState(project.name);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) notify(done, 'info');
      props.onChanged();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel settings" aria-label="Project settings">
      <h2>Project settings</h2>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== project.name)
            void run(() => api.patch(`/projects/${project.id}`, { name }), 'Renamed.');
        }}
      >
        <label class="field grow">
          Name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} required />
        </label>
        <button type="submit" disabled={busy || !name.trim() || name.trim() === project.name}>
          Rename
        </button>
      </form>

      <h3>Repos</h3>
      <ul class="repos">
        {project.repos.map((r) => (
          <li key={r}>
            <span class="mono">{r}</span>
            <button
              type="button"
              class="plain danger"
              disabled={busy}
              aria-label={`Remove ${r}`}
              onClick={() => {
                if (confirm(`Remove ${r} from ${project.name}? Its existing cards stay on this board.`))
                  void run(() => api.patch(`/projects/${project.id}`, { removeRepos: [r] }));
              }}
            >
              Remove
            </button>
          </li>
        ))}
        {project.repos.length === 0 ? <li class="muted">No repos. Add one so cards can be created.</li> : null}
      </ul>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!repo.trim()) return;
          void run(async () => {
            await api.patch(`/projects/${project.id}`, { addRepos: [repo.trim()] });
            setRepo('');
          });
        }}
      >
        <label class="field grow">
          Add a repo
          <input
            value={repo}
            onInput={(e) => setRepo(e.currentTarget.value)}
            placeholder="owner/name or the clone URL"
          />
        </label>
        <button type="submit" disabled={busy || !repo.trim()}>
          Add repo
        </button>
      </form>

      <h3>Archive</h3>
      <p class="muted">Archiving hides the project and frees its repos. It is refused while any card is claimed.</p>
      <button
        type="button"
        class="danger"
        disabled={busy}
        onClick={() => {
          if (confirm(`Archive ${project.name}?`)) {
            void run(async () => {
              await api.post(`/projects/${project.id}/archive`);
              navigate('/');
            });
          }
        }}
      >
        Archive project
      </button>
    </section>
  );
}
