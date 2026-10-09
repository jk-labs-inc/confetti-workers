const MAX_RETURN_PATH_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const readJsonObject = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const parseReturnPath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  return value;
};
