export type HttpRequest = (
  url: URL,
  options: RequestInit & { headers?: Record<string, string> },
) => Promise<Response>;
