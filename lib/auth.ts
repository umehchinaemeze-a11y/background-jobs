import { authUsers } from "./config";
import { unauthorized } from "./errors";

export interface Principal {
  userId: string;
}

/**
 * Minimal ownership mechanism for this slice: a bearer token maps to a
 * configured userId (AUTH_USERS). Every job row is stamped with userId and
 * every read is scoped by userId, so no user can observe another user's jobs.
 */
export function authenticate(request: Request): Principal {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("Missing bearer token");
  }
  const token = header.slice("bearer ".length).trim();
  if (!token) {
    throw unauthorized("Missing bearer token");
  }
  const users = authUsers();
  for (const [userId, userToken] of Object.entries(users)) {
    if (userToken === token) {
      return { userId };
    }
  }
  throw unauthorized("Invalid bearer token");
}