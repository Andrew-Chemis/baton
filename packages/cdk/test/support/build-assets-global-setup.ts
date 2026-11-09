// The synth test points Code.fromAsset and BucketDeployment at the built assets, so build them first.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup() {
  execFileSync('node', ['scripts/build-assets.mts'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'inherit' });
}
