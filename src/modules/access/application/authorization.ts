export type AuthorizeProject = (userId: string, projectId: string, write: boolean) => Promise<void>;
export interface Authorization {
  authenticate(header: string | undefined): Promise<string>;
  authorizeProject: AuthorizeProject;
}
export type AuthMode = 'timepost' | 'api-key';
