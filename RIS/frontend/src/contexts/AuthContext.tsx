import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { resolveBackendUrl } from "@/lib/backendUrl";
import { resolveRoleLandingPage } from "@/lib/roleLanding";
import {
  installSessionFetchGuard,
  onSessionExpired,
  startSessionWatch,
} from "@/lib/session";

interface User {
  username: string;
  role: string;
  fullName: string;
  permissions: string[];
  theme?: "light" | "dark";
  defaultLandingPage?: string;
}

interface LoginResult {
  success: boolean;
  landingPage: string | null;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  permissions: string[];
  hasPermission: (permission: string) => boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  loginWithGoogle: (idToken: string) => Promise<LoginResult>;
  logout: () => void;
  setUserTheme: (theme: "light" | "dark") => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Mock users for demo - will be replaced with DB integration
const MOCK_USERS = [
  { username: "admin", password: "admin123", role: "admin" as const, fullName: "Administrator" },
  { username: "doctor", password: "doctor123", role: "editor" as const, fullName: "Dr. Radiologist" },
  { username: "viewer", password: "viewer123", role: "viewer" as const, fullName: "Viewer User" },
];
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const LAST_ACTIVE_KEY = "nexia_last_active";
const USER_THEME_KEY_PREFIX = "nexia_theme_";
const BACKEND_URL = resolveBackendUrl();

const getStoredUserTheme = (username: string): "light" | "dark" | null => {
  try {
    const stored = window.localStorage.getItem(`${USER_THEME_KEY_PREFIX}${username}`);
    if (stored === "dark") return "dark";
    if (stored === "light") return "light";
    return null;
  } catch {
    return null;
  }
};

const setStoredUserTheme = (username: string, theme: "light" | "dark") => {
  try {
    window.localStorage.setItem(`${USER_THEME_KEY_PREFIX}${username}`, theme);
  } catch {
    return;
  }
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [initialized, setInitialized] = useState(false);
  // Read from effects/callbacks that must not be re-created on every login.
  const userRef = useRef<User | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const updateStoredUser = useCallback((nextUser: User | null) => {
    setUser(nextUser);
    try {
      if (nextUser) {
        window.localStorage.setItem("nexia_auth_user", JSON.stringify(nextUser));
        window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      } else {
        window.localStorage.removeItem("nexia_auth_user");
        window.localStorage.removeItem(LAST_ACTIVE_KEY);
      }
    } catch {
      return;
    }
  }, []);

  const loadRoleProfile = useCallback(async (role: string) => {
    const response = await fetch(`${BACKEND_URL}/roles/${encodeURIComponent(role)}`);
    if (!response.ok) return { permissions: [] as string[], defaultLandingPage: null as string | null };
    const data = await response.json();
    return {
      permissions: Array.isArray(data?.permissions)
        ? data.permissions.filter((p: unknown) => typeof p === "string")
        : [],
      defaultLandingPage:
        typeof data?.default_landing_page === "string" ? data.default_landing_page : null,
    };
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("nexia_auth_user");
      if (stored) {
        const lastActiveRaw = window.localStorage.getItem(LAST_ACTIVE_KEY);
        const lastActive = lastActiveRaw ? Number(lastActiveRaw) : null;
        if (lastActive && Date.now() - lastActive > IDLE_TIMEOUT_MS) {
          window.localStorage.removeItem("nexia_auth_user");
          window.localStorage.removeItem(LAST_ACTIVE_KEY);
        } else {
          const parsed = JSON.parse(stored) as User | null;
          if (parsed && parsed.username && parsed.role && parsed.fullName) {
            const storedTheme = getStoredUserTheme(parsed.username);
            const permissions = Array.isArray(parsed.permissions)
              ? parsed.permissions.filter(p => typeof p === "string")
              : [];
            const nextUser: User = {
              username: parsed.username,
              role: parsed.role,
              fullName: parsed.fullName,
              permissions,
              theme: parsed.theme === "dark" ? "dark" : storedTheme ?? "light",
              defaultLandingPage: resolveRoleLandingPage(
                parsed.defaultLandingPage,
                permissions,
                parsed.role
              ),
            };
            setStoredUserTheme(nextUser.username, nextUser.theme ?? "light");
            setUser(nextUser);
            if (!lastActive) {
              window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
            }
            if (!permissions.length) {
              loadRoleProfile(parsed.role)
                .then(profile => {
                  if (profile.permissions.length) {
                    updateStoredUser({
                      ...nextUser,
                      permissions: profile.permissions,
                      defaultLandingPage: resolveRoleLandingPage(
                        profile.defaultLandingPage,
                        profile.permissions,
                        parsed.role
                      ),
                    });
                  }
                })
                .catch(() => undefined);
            }
          }
        }
      }
    } catch {
      return;
    } finally {
      setInitialized(true);
    }
  }, [loadRoleProfile, updateStoredUser]);

  const loginWithGoogle = useCallback(async (idToken: string): Promise<LoginResult> => {
    try {
      const response = await fetch(`${BACKEND_URL}/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.user) {
          const storedTheme = getStoredUserTheme(data.user.username);
          const permissions = Array.isArray(data.user.permissions)
            ? data.user.permissions.filter((p: unknown) => typeof p === "string")
            : [];
          const normalizedTheme = data.user.theme === "dark" ? "dark" : "light";
          const nextUser: User = {
            username: data.user.username,
            role: data.user.role,
            fullName: data.user.fullName,
            theme: storedTheme ?? normalizedTheme,
            permissions,
            defaultLandingPage: resolveRoleLandingPage(
              data.user.defaultLandingPage,
              permissions,
              data.user.role
            ),
          };
          if (!permissions.length && data.user.role) {
            const profile = await loadRoleProfile(data.user.role);
            if (profile.permissions.length) {
              nextUser.permissions = profile.permissions;
              nextUser.defaultLandingPage = resolveRoleLandingPage(
                profile.defaultLandingPage,
                profile.permissions,
                data.user.role
              );
            }
          }
          updateStoredUser(nextUser);
          if (storedTheme && storedTheme !== normalizedTheme) {
            fetch(`${BACKEND_URL}/users/theme`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "x-user-role": data.user.role,
              },
              body: JSON.stringify({ username: data.user.username, theme: storedTheme }),
            }).catch(() => undefined);
          }
          setStoredUserTheme(nextUser.username, nextUser.theme ?? "light");
          return { success: true, landingPage: nextUser.defaultLandingPage || null };
        }
      }
      return { success: false, landingPage: null };
    } catch (error) {
      console.error("Google login request failed", error);
      return { success: false, landingPage: null };
    }
  }, [loadRoleProfile, updateStoredUser]);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    try {
      const response = await fetch(`${BACKEND_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.user) {
          const storedTheme = getStoredUserTheme(data.user.username);
          const permissions = Array.isArray(data.user.permissions)
            ? data.user.permissions.filter((p: unknown) => typeof p === "string")
            : [];
          const normalizedTheme = data.user.theme === "dark" ? "dark" : "light";
          const nextUser: User = {
            username: data.user.username,
            role: data.user.role,
            fullName: data.user.fullName,
            theme: storedTheme ?? normalizedTheme,
            permissions,
            defaultLandingPage: resolveRoleLandingPage(
              data.user.defaultLandingPage,
              permissions,
              data.user.role
            ),
          };
          if (!permissions.length && data.user.role) {
            const profile = await loadRoleProfile(data.user.role);
            if (profile.permissions.length) {
              nextUser.permissions = profile.permissions;
              nextUser.defaultLandingPage = resolveRoleLandingPage(
                profile.defaultLandingPage,
                profile.permissions,
                data.user.role
              );
            }
          }
          updateStoredUser(nextUser);
          if (storedTheme && storedTheme !== normalizedTheme) {
            fetch(`${BACKEND_URL}/users/theme`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "x-user-role": data.user.role,
              },
              body: JSON.stringify({ username: data.user.username, theme: storedTheme }),
            }).catch(() => undefined);
          }
          setStoredUserTheme(nextUser.username, nextUser.theme ?? "light");
          return { success: true, landingPage: nextUser.defaultLandingPage || null };
        }
      }
      return { success: false, landingPage: null };
    } catch (error) {
      console.error("Login request failed", error);
      return { success: false, landingPage: null };
    }
  }, [loadRoleProfile, updateStoredUser]);

  const logout = useCallback(() => {
    updateStoredUser(null);
  }, [updateStoredUser]);

  const setUserTheme = useCallback((theme: "light" | "dark") => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, theme };
      updateStoredUser(next);
      setStoredUserTheme(next.username, theme);
      return next;
    });
  }, [updateStoredUser]);

  const permissions = user?.permissions ?? [];
  const hasPermission = (permission: string) => permissions.includes(permission);

  // Any 401/403 while a session is believed active means the session is gone.
  // Installed once at provider level so every page is covered without touching
  // each request site.
  useEffect(() => {
    installSessionFetchGuard(() => Boolean(userRef.current));
  }, []);

  // Expire the session from a timer, not only from user activity: a tab left
  // open and untouched must stop looking signed-in.
  useEffect(() => startSessionWatch(() => Boolean(userRef.current)), []);

  // A dropped session must send the operator to the login screen immediately.
  useEffect(() => onSessionExpired(() => {
    setUser(null);
  }), []);

  useEffect(() => {
    if (!user) return;
    const updateActivity = () => {
      try {
        window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      } catch {
        return;
      }
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "keydown",
      "click",
      "scroll",
      "touchstart",
    ];
    updateActivity();
    events.forEach(event => window.addEventListener(event, updateActivity));
    const visibilityHandler = () => {
      if (document.visibilityState === "visible") updateActivity();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    const intervalId = window.setInterval(() => {
      try {
        const lastActiveRaw = window.localStorage.getItem(LAST_ACTIVE_KEY);
        const lastActive = lastActiveRaw ? Number(lastActiveRaw) : null;
        if (lastActive && Date.now() - lastActive > IDLE_TIMEOUT_MS) {
          updateStoredUser(null);
        }
      } catch {
        return;
      }
    }, 60000);
    return () => {
      events.forEach(event => window.removeEventListener(event, updateActivity));
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.clearInterval(intervalId);
    };
  }, [updateStoredUser, user]);

  if (!initialized) {
    return null;
  }

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, permissions, hasPermission, login, loginWithGoogle, logout, setUserTheme }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
