// The wire types come from the service, which owns them; the web app imports them as types and the column list as a value.
export type {
  AgentView,
  ApiErrorBody,
  CardView,
  Column,
  EventView,
  ProjectCounts,
  ProjectView,
} from '../../service/api-types.ts';
export { COLUMNS } from '../../service/api-types.ts';

/** What /config.json carries. Without `cognito` (local development) the app runs signed in as whoever the server says. */
export interface AppConfig {
  apiUrl: string;
  cognito?: { domain: string; clientId: string };
}
