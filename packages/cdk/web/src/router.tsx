// Three pages do not need a router library: the path decides the page, the query holds the open card.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export interface Route {
  path: string;
  query: URLSearchParams;
}

const read = (): Route => ({ path: location.pathname, query: new URLSearchParams(location.search) });
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  return route;
}

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
}

export function Link(props: { href: string; class?: string; children: ComponentChildren }): JSX.Element {
  return (
    <a
      href={props.href}
      class={props.class}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
