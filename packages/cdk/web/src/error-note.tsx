/** A problem a page is showing, announced to screen readers. Nothing when there is none. */
export function ErrorNote(props: { text: string | null | undefined }) {
  return props.text ? (
    <p class="error" role="alert">
      {props.text}
    </p>
  ) : null;
}
