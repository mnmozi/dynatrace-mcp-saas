export interface Config {
  platformUrl: string | undefined;
  classicUrl: string | undefined;
  platformToken: string | undefined;
  apiToken: string | undefined;
  enableWrites: boolean;
  timeoutMs: number;
  /** Optional dedicated platform token carrying iam:* scopes; IAM tools prefer it. */
  iamToken?: string;
  /** Account Management API (OAuth client-credentials) — all three set, or none. */
  oauthClientId?: string;
  oauthClientSecret?: string;
  accountUrn?: string;
  ssoTokenUrl?: string;
  accountApiUrl?: string;
  maxRetries: number;
  retryBaseMs: number;
}

export type QueryParams = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface HostClient {
  get<T = unknown>(path: string, query?: QueryParams): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  del<T = unknown>(path: string, query?: QueryParams): Promise<T>;
  /** Send a multipart/form-data POST. Let fetch set the Content-Type boundary automatically. */
  postForm<T = unknown>(path: string, form: FormData, query?: QueryParams): Promise<T>;
  /** Send a multipart/form-data PATCH. Let fetch set the Content-Type boundary automatically. */
  patchForm<T = unknown>(path: string, form: FormData, query?: QueryParams): Promise<T>;
  /** GET raw text (e.g. document content). Returns the raw response text. */
  getText(path: string, query?: QueryParams): Promise<string>;
}
