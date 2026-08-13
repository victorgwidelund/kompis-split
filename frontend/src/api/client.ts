export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// A rolling trail of the user's most recent API activity, for the bug-report dialog to attach as
// context. Method, path and outcome only -- never request/response bodies -- so this never becomes a
// second place that has to be told not to log sensitive data (amounts, names, receipt contents, ...).
const breadcrumbTrail: string[] = [];
const maxBreadcrumbs = 30;
function recordBreadcrumb(entry: string) {
  breadcrumbTrail.push(`${new Date().toISOString().slice(11, 19)} ${entry}`);
  if (breadcrumbTrail.length > maxBreadcrumbs) breadcrumbTrail.shift();
}
export function getBreadcrumbs(): string[] {
  return [...breadcrumbTrail];
}

type ApiOptions = Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const isRawBody = options.body instanceof Blob || options.body instanceof ArrayBuffer || typeof options.body === "string";
  const body = options.body && !isRawBody ? JSON.stringify(options.body) : options.body as BodyInit | null | undefined;
  const headers = new Headers(options.headers);
  if (body && !headers.has("Content-Type") && !isRawBody) headers.set("Content-Type", "application/json");
  if (!body && options.method && options.method !== "GET" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = options.method || "GET";
  const pathOnly = path.split("?")[0];
  let response: Response;
  try {
    response = await fetch(path, { ...options, body, headers, credentials: "same-origin" });
  } catch (error) {
    recordBreadcrumb(`${method} ${pathOnly} → nätverksfel`);
    throw error;
  }
  recordBreadcrumb(`${method} ${pathOnly} → ${response.status}`);
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 401) window.dispatchEvent(new Event("kompis:unauthorized"));
  if (!response.ok) throw new ApiError(payload.error || "Något gick fel", response.status);
  return payload as T;
}

export function upload<T>(path: string, file: File, headers: HeadersInit = {}): Promise<T> {
  return api<T>(path, { method: "POST", headers: { "Content-Type": file.type, ...headers }, body: file });
}
