import { useEffect, useState } from 'preact/hooks';
import { Agents } from './agents.tsx';
import { emailOf, finishSignIn, signedIn, signOut, startSignIn } from './auth.ts';
import { Board } from './board.tsx';
import { Dashboard } from './dashboard.tsx';
import { AutoIcon, MoonIcon, SunIcon } from './icons.tsx';
import { Link, navigate, useRoute } from './router.tsx';
import { Toasts } from './toast.tsx';
import type { AppConfig } from './types.ts';
import { store } from './util.ts';

type Theme = 'auto' | 'light' | 'dark';
const THEMES: Theme[] = ['auto', 'light', 'dark'];

export function applyTheme(theme: Theme): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function savedTheme(): Theme {
  const value = store.get('baton.theme');
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] as Theme;
  const Icon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : AutoIcon;
  return (
    <button
      type="button"
      class="plain icon-button"
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme}`}
      onClick={() => {
        applyTheme(next);
        store.set('baton.theme', next === 'auto' ? null : next);
        setTheme(next);
      }}
    >
      <Icon />
      <span class="theme-name">{theme}</span>
    </button>
  );
}

function Callback({ config }: { config: AppConfig }) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const result = await finishSignIn(config, location.search);
      if ('error' in result) setProblem(result.error);
      else navigate(result.returnTo, true);
    })();
  }, [config]);
  return (
    <main class="page narrow">
      {problem ? (
        <>
          <h1>Sign-in did not finish</h1>
          <p class="error" role="alert">
            {problem}
          </p>
          <button type="button" class="primary" onClick={() => void startSignIn(config, '/')}>
            Sign in again
          </button>
        </>
      ) : (
        <p>Signing in…</p>
      )}
    </main>
  );
}

export function App({ config }: { config: AppConfig }) {
  const route = useRoute();
  const needsSignIn = Boolean(config.cognito) && !signedIn() && route.path !== '/auth/callback';
  useEffect(() => {
    if (needsSignIn) void startSignIn(config, location.pathname + location.search);
  }, [needsSignIn, config]);

  let page;
  const board = /^\/p\/([^/]+)\/?$/.exec(route.path);
  if (needsSignIn)
    page = (
      <main class="page narrow">
        <p>Signing in…</p>
      </main>
    );
  else if (route.path === '/auth/callback') page = <Callback config={config} />;
  else if (route.path === '/') page = <Dashboard />;
  else if (board) page = <Board projectId={decodeURIComponent(board[1] as string)} route={route} />;
  else if (route.path === '/agents') page = <Agents />;
  else {
    page = (
      <main class="page narrow">
        <h1>Not found</h1>
        <p>
          <Link href="/">Back to the projects</Link>
        </p>
      </main>
    );
  }

  const email = config.cognito ? emailOf() : null;
  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        <Link href="/" class="brand">
          Baton
        </Link>
        <nav aria-label="Main">
          <Link href="/" class={route.path === '/' || route.path.startsWith('/p/') ? 'current' : undefined}>
            Projects
          </Link>
          <Link href="/agents" class={route.path === '/agents' ? 'current' : undefined}>
            Agents
          </Link>
        </nav>
        <span class="grow" />
        <ThemeToggle />
        {config.cognito ? (
          <span class="who">
            {email ? <span class="muted who-email">{email}</span> : null}
            <button type="button" class="plain" onClick={() => signOut(config)}>
              Sign out
            </button>
          </span>
        ) : null}
      </header>
      <div id="main">{page}</div>
      <Toasts />
    </>
  );
}
