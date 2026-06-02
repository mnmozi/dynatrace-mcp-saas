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
}
