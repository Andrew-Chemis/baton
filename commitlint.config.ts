export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Body lines at most 100 columns; the release notes quote them.
    'body-max-line-length': [2, 'always', 100],
  },
};
