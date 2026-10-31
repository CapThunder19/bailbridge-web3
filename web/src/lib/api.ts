export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `Request failed (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    if (res.status === 502 || res.status === 504) message = "The BailBridge server is unreachable.";
  }
  throw new ApiError(message, res.status);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The BailBridge server is unreachable.", 0);
  }
  return handle<T>(res);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),

  /** Download exact bytes (PDFs) — the caller hashes these same bytes. */
  async bytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`/api${path}`, { credentials: "same-origin" });
    if (!res.ok) await handle(res);
    return new Uint8Array(await res.arrayBuffer());
  },

  /** Upload exact bytes as application/pdf. */
  async uploadPdf<T>(path: string, bytes: Uint8Array): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/pdf" },
        body: new Blob([bytes as BlobPart], { type: "application/pdf" }),
      });
    } catch {
      throw new ApiError("The BailBridge server is unreachable.", 0);
    }
    return handle<T>(res);
  },
};
