import { join } from 'node:path';

// Resolved from this file, which sits in lib/ once compiled and in src/ under test: either way assets/ is one level up, inside
// the installed package, so a consumer builds nothing.
const PACKAGE_ROOT = join(__dirname, '..');

/** The Lambda bundle directory (holds index.js). */
export const API_ASSET_PATH = join(PACKAGE_ROOT, 'assets', 'api');

/** The built web app (holds index.html). */
export const WEB_ASSET_PATH = join(PACKAGE_ROOT, 'assets', 'web');
