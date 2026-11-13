// Remote URLs people and CI systems actually have, and the owner/name each must come out as. The CLI and the service each
// carry their own normalizer (the CLI is dependency-free and ships alone), and test/repo-parity.test.ts holds them to this table.
export const REPO_URLS: [input: string, expected: string][] = [
  ['https://github.com/Acme/Widgets.git', 'acme/widgets'],
  ['https://github.com/acme/widgets', 'acme/widgets'],
  ['git@github.com:Acme/Widgets.git', 'acme/widgets'],
  ['ssh://git@github.com/acme/widgets.git/', 'acme/widgets'],
  ['https://x-access-token:secret@github.com/acme/widgets.git', 'acme/widgets'],
  ['http://local_proxy@127.0.0.1:9999/git/acme/widgets', 'acme/widgets'],
  ['acme/widgets', 'acme/widgets'],
];
