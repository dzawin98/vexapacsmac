import { create } from 'zustand'
import { appUrl } from '../../config/appBase'
import type { PermissionId } from './permissions'
import { createDefaultViewerOverlayConfig, normalizeViewerOverlayConfig, type ViewerOverlayConfig } from '../viewer/overlayConfig'

export type AuthRole = {
  id: string
  name: string
  description: string
  permissions: PermissionId[]
  seriesPolicy?: SeriesAccessPolicy
}

export type AuthUser = {
  id: string
  username: string
  fullName: string
  roleIds: string[]
  active: boolean
}

export type SeriesAccessPolicy = {
  maxImagesPerSeries?: number
  blockedModalities?: string[]
}

type UserDraft = Omit<AuthUser, 'id'> & { id?: string; password?: string }
type RoleDraft = Omit<AuthRole, 'id'> & { id?: string }

type SessionPayload = {
  user: AuthUser | null
  roles: AuthRole[]
  permissions: PermissionId[]
  viewerOverlay?: ViewerOverlayConfig
}

type ServicePayload = {
  users: AuthUser[]
  roles: AuthRole[]
  config?: ServiceConfig
  monitoring?: ServiceMonitoring
}

export type ServiceConfig = {
  risHeaderName: string
  risSharedSecret: string
  risLaunchTtlSeconds: number
  viewerOverlay: ViewerOverlayConfig
}

export type ActiveSessionInfo = {
  id: string
  userId: string
  username: string
  fullName: string
  ipAddress: string
  browser: string
  userAgent: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export type ServiceMonitoring = {
  concurrentUsers: number
  activeSessions: ActiveSessionInfo[]
}

type AuthState = {
  currentUser: AuthUser | null
  currentRoles: AuthRole[]
  permissions: PermissionId[]
  users: AuthUser[]
  roles: AuthRole[]
  serviceConfig: ServiceConfig | null
  viewerOverlayConfig: ViewerOverlayConfig
  monitoring: ServiceMonitoring | null
  initialized: boolean
  loading: boolean
  loginError: string
  serviceError: string
  hydrate: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  hasPermission: (permission: PermissionId) => boolean
  loadServiceData: () => Promise<void>
  saveServiceConfig: (config: ServiceConfig) => Promise<void>
  saveUser: (draft: UserDraft) => Promise<void>
  deleteUser: (userId: string) => Promise<void>
  saveRole: (draft: RoleDraft) => Promise<void>
  deleteRole: (roleId: string) => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentUser: null,
  currentRoles: [],
  permissions: [],
  users: [],
  roles: [],
  serviceConfig: null,
  viewerOverlayConfig: createDefaultViewerOverlayConfig(),
  monitoring: null,
  initialized: false,
  loading: false,
  loginError: '',
  serviceError: '',
  hydrate: async () => {
    set({ loading: true })
    try {
      const session = await api<SessionPayload>('/api/auth/session')
      set({
        currentUser: session.user,
        currentRoles: session.roles,
        permissions: session.permissions,
        viewerOverlayConfig: normalizeViewerOverlayConfig(session.viewerOverlay),
        initialized: true,
        loading: false,
        loginError: '',
      })
    } catch {
      set({ currentUser: null, currentRoles: [], permissions: [], viewerOverlayConfig: createDefaultViewerOverlayConfig(), initialized: true, loading: false })
    }
  },
  login: async (username, password) => {
    set({ loading: true, loginError: '' })
    try {
      const session = await api<SessionPayload>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      })
      set({
        currentUser: session.user,
        currentRoles: session.roles,
        permissions: session.permissions,
        viewerOverlayConfig: normalizeViewerOverlayConfig(session.viewerOverlay),
        initialized: true,
        loading: false,
      })
      return Boolean(session.user)
    } catch (error) {
      set({ loading: false, loginError: error instanceof Error ? error.message : 'Sign-in failed.' })
      return false
    }
  },
  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } finally {
      set({ currentUser: null, currentRoles: [], permissions: [], users: [], roles: [], serviceConfig: null, viewerOverlayConfig: createDefaultViewerOverlayConfig(), monitoring: null, initialized: true, loginError: '' })
    }
  },
  hasPermission: (permission) => get().permissions.includes(permission),
  loadServiceData: async () => {
    set({ serviceError: '' })
    try {
      const payload = await api<ServicePayload>('/api/auth/service')
      set({
        users: payload.users,
        roles: payload.roles,
        serviceConfig: payload.config ?? null,
        viewerOverlayConfig: normalizeViewerOverlayConfig(payload.config?.viewerOverlay),
        monitoring: payload.monitoring ?? null,
      })
    } catch (error) {
      set({ serviceError: error instanceof Error ? error.message : 'Unable to load service data.' })
    }
  },
  saveServiceConfig: async (config) => {
    const payload = await api<{ config: ServiceConfig; monitoring: ServiceMonitoring }>('/api/auth/service/config', { method: 'POST', body: config })
    set({ serviceConfig: payload.config, viewerOverlayConfig: normalizeViewerOverlayConfig(payload.config.viewerOverlay), monitoring: payload.monitoring, serviceError: '' })
  },
  saveUser: async (draft) => {
    const payload = await api<ServicePayload>('/api/auth/users', { method: 'POST', body: draft })
    set({ users: payload.users, roles: payload.roles, serviceError: '' })
  },
  deleteUser: async (userId) => {
    const payload = await api<ServicePayload>(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
    set({ users: payload.users, roles: payload.roles, serviceError: '' })
  },
  saveRole: async (draft) => {
    const payload = await api<ServicePayload>('/api/auth/roles', { method: 'POST', body: draft })
    set({ users: payload.users, roles: payload.roles, serviceError: '' })
  },
  deleteRole: async (roleId) => {
    const payload = await api<ServicePayload>(`/api/auth/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' })
    set({ users: payload.users, roles: payload.roles, serviceError: '' })
  },
}))

export function useCurrentUser() {
  return useAuthStore((state) => state.currentUser)
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(appUrl(path), {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Request failed.')
  }
  return payload as T
}
