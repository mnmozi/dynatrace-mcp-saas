export interface Config {
  platformUrl: string;
  classicUrl: string;
  platformToken: string;
  apiToken: string;
  enableWrites: boolean;
  timeoutMs: number;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

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
