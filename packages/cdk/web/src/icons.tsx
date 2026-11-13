import type { JSX } from 'preact';

// Small geometric glyphs, one per card state, so a badge differs by shape as well as by colour.
const svg = (children: JSX.Element, label?: string): JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden={label ? undefined : 'true'}
    role={label ? 'img' : undefined}
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {label ? <title>{label}</title> : null}
    {children}
  </svg>
);

export const ClaimedIcon = () => svg(<circle cx="8" cy="8" r="4.2" fill="currentColor" />);
export const StaleIcon = () =>
  svg(
    <>
      <path d="M8 2.2 14.2 13H1.8z" />
      <path d="M8 6.4v3.2M8 11.4v.1" />
    </>,
  );
export const UnownedIcon = () => svg(<circle cx="8" cy="8" r="4.6" stroke-dasharray="2.2 2.2" />);
export const ReopenedIcon = () =>
  svg(
    <>
      <path d="M3 8a5 5 0 1 0 1.7-3.8" />
      <path d="M3 2.6v3.2h3.2" />
    </>,
  );
export const UnreadIcon = () =>
  svg(
    <>
      <path d="M2.4 3.4h11.2v7H7.2L4.4 13v-2.6H2.4z" />
      <circle cx="12.6" cy="3.4" r="2.2" fill="currentColor" stroke="none" />
    </>,
  );
export const GripIcon = () =>
  svg(
    <>
      <path d="M6 3.5v.1M10 3.5v.1M6 8v.1M10 8v.1M6 12.5v.1M10 12.5v.1" stroke-width="2.4" />
    </>,
  );
export const SunIcon = () =>
  svg(
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </>,
  );
export const MoonIcon = () => svg(<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />);
export const AutoIcon = () =>
  svg(
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 2.6v10.8" />
      <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" />
    </>,
  );
