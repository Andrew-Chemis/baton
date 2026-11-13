/**
 * The data schema version this release of the code expects. The construct deploys it as the migration resource's property, so
 * a deploy that raises it runs the new migrations; service/migrations.ts must end at this version (a test checks).
 */
export const LATEST_SCHEMA = 1;
