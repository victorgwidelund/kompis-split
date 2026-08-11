export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type ApiOptions = Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const isRawBody = options.body instanceof Blob || options.body instanceof ArrayBuffer || typeof options.body === "string";
  const body = options.body && !isRawBody ? JSON.stringify(options.body) : options.body as BodyInit | null | undefined;
  const headers = new Headers(options.headers);
  if (body && !headers.has("Content-Type") && !isRawBody) headers.set("Content-Type", "application/json");
  if (!body && options.method && options.method !== "GET" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, body, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 401) window.dispatchEvent(new Event("kompis:unauthorized"));
  if (!response.ok) throw new ApiError(payload.error || "Något gick fel", response.status);
  return payload as T;
}

export function upload<T>(path: string, file: File, headers: HeadersInit = {}): Promise<T> {
  return api<T>(path, { method: "POST", headers: { "Content-Type": file.type, ...headers }, body: file });
}
