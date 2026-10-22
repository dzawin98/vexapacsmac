/**
 * Session expiry handling for the RIS frontend.
 *
 * The RIS auth model sends the user's role in an `x-user-role` header on every
 * request and re-derives permissions server-side. That means an expired session
 * does NOT produce a 401: once the stored user record goes away the requests go
 * out without the header and the backend answers 403 Forbidden. The UI has no
 * interceptor, so a stale tab keeps rendering whatever it already had in memory
 * and every action fails with a permission error instead of asking for a login.
 *
 * This module gives the app one place to:
 *   - know how long the session has been idle and when it expires,
 *   - detect the expiry the moment it happens (local timer AND a backend 401/403),
 *   - clear the stale session and send the user to /login with a clear reason.
 */

export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const LAST_ACTIVE_KEY = "nexia_last_active";
const EXPIRED_REASON_KEY = "nexia_session_expired";

/** Persisted across the redirect so the login page can explain why it appeared. */
export type SessionExpiredReason = "idle" | "rejected";

type SessionExpiredListener = (reason: SessionExpiredReason) => void;

const listeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let handling = false;

/**
 * Clears the stale session and notifies the app. Safe to call repeatedly: the
 * first caller wins, so a burst of parallel 403s produces exactly one redirect.
 */
export function expireSession(reason: SessionExpiredReason) {
  if (handling) return;
  handling = true;

  try {
    window.localStorage.removeItem("nexia_auth_user");
    window.localStorage.removeItem(LAST_ACTIVE_KEY);
    window.sessionStorage.setItem(EXPIRED_REASON_KEY, reason);
  } catch {
    // Storage can be unavailable (private mode); the redirect below still works.
  }

  for (const listener of listeners) {
    try {
      listener(reason);
    } catch {
      // Never let a listener break the redirect.
    }
  }

  // Re-arm after the redirect so a later session can expire again.
  window.setTimeout(() => {
    handling = false;
  }, 2000);
}

export function consumeSessionExpiredReason(): SessionExpiredReason | null {
  try {
    const stored = window.sessionStorage.getItem(EXPIRED_REASON_KEY);
    if (!stored) return null;
    window.sessionStorage.removeItem(EXPIRED_REASON_KEY);
    return stored === "idle" || stored === "rejected" ? stored : null;
  } catch {
    return null;
  }
}

export function touchSessionActivity(now = Date.now()) {
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch {
    return;
  }
}

/** Milliseconds until the session expires, or 0 when it already has. */
export function getIdleRemainingMs(now = Date.now()) {
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_KEY);
    if (!raw) return 0;
    const lastActive = Number(raw);
    if (!Number.isFinite(lastActive)) return 0;
    return Math.max(0, lastActive + SESSION_IDLE_TIMEOUT_MS - now);
  } catch {
    return 0;
  }
}

export function isSessionIdle(now = Date.now()) {
  return getIdleRemainingMs(now) === 0;
}

/**
 * Decides whether a failed response means "your session is gone".
 *
 * 401 is unambiguous. 403 is how this backend answers a request that arrived
 * without a role, because `requirePermission` returns 403 when the header is
 * missing — indistinguishable at the status level from a genuine permission
 * denial, so the caller must pass `hadSession` and we only treat it as expiry
 * while a session was believed to be active.
 */
export function isSessionRejection(status: number, hadSession: boolean) {
  if (status === 401) return true;
  return status === 403 && hadSession;
}

/**
 * Watches the idle deadline on a short interval and expires the session even
 * while the tab sits untouched, so the UI stops looking signed-in.
 */
export function startSessionWatch(hasSession: () => boolean, intervalMs = 15000) {
  const timer = window.setInterval(() => {
    if (!hasSession()) return;
    if (isSessionIdle()) {
      expireSession("idle");
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}

let fetchGuardInstalled = false;

/**
 * Installs a single global fetch guard so EVERY request in the app can detect a
 * dead session, instead of adding an interceptor to each page.
 *
 * The response is returned untouched; only the status is inspected. A 403 is
 * treated as expiry only while a session was believed active (`hasSession()`),
 * because this backend answers a missing role header with 403 as well.
 */
export function installSessionFetchGuard(hasSession: () => boolean) {
  if (fetchGuardInstalled || typeof window === "undefined") return;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const hadSession = hasSession();
    let response: Response;
    try {
      response = await originalFetch(...args);
    } catch (error) {
      throw error;
    }

    if (hadSession && isSessionRejection(response.status, hadSession)) {
      expireSession("rejected");
    }

    return response;
  };

  fetchGuardInstalled = true;
}
