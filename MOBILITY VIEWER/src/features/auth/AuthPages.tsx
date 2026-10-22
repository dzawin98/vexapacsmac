import { Activity, ArrowLeft, Check, KeyRound, LogIn, LogOut, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore, useCurrentUser, type AuthRole, type AuthUser, type ServiceConfig } from './authStore'
import { permissions, type PermissionId } from './permissions'

export function RequireAuth({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser()
  const initialized = useAuthStore((state) => state.initialized)
  const hydrate = useAuthStore((state) => state.hydrate)
  const location = useLocation()

  useEffect(() => {
    if (!initialized) void hydrate()
  }, [hydrate, initialized])

  if (!initialized) return <AuthLoadingPage />

  return currentUser ? children : <Navigate to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />
}

export function RequireServiceAdmin({ children }: { children: ReactNode }) {
  const hasPermission = useAuthStore((state) => state.hasPermission)

  return hasPermission('service.manage') ? children : <AccessDeniedPage />
}

export function RequireViewerAccess({ children }: { children: ReactNode }) {
  const hasPermission = useAuthStore((state) => state.hasPermission)

  return hasPermission('study.view') ? children : <AccessDeniedPage />
}

function AccessDeniedPage() {
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()
  return (
    <main className="auth-page">
      <section className="auth-card">
        <ShieldCheck size={30} />
        <div><p className="auth-eyebrow">Access Denied</p><h1>Viewer permission required</h1></div>
        <p className="auth-error">This account is not permitted to open studies.</p>
        <button className="auth-primary-button" type="button" onClick={() => { void logout().then(() => navigate('/login', { replace: true })) }}><LogOut size={17} />Sign Out</button>
      </section>
    </main>
  )
}

function AuthLoadingPage() {
  return <main className="launch-blank-page" aria-label="Loading" />
}

export function LoginPage() {
  const login = useAuthStore((state) => state.login)
  const loginError = useAuthStore((state) => state.loginError)
  const initialized = useAuthStore((state) => state.initialized)
  const hydrate = useAuthStore((state) => state.hydrate)
  const currentUser = useCurrentUser()
  const location = useLocation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const next = new URLSearchParams(location.search).get('next') || '/service'

  useEffect(() => {
    if (!initialized) void hydrate()
  }, [hydrate, initialized])

  if (!initialized) return <AuthLoadingPage />
  if (currentUser) return <Navigate to={next} replace />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    const accepted = await login(username, password)
    setSubmitting(false)
    if (accepted) navigate(next, { replace: true })
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <img className="auth-logo" src="/vexa.png" alt="Viewer" />
        <div>
          <h1>Viewer</h1>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>Username</span>
            <input autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.currentTarget.value)} />
          </label>
          <label>
            <span>Password</span>
            <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
          </label>
          {loginError && <p className="auth-error">{loginError}</p>}
          <button className="auth-primary-button" disabled={submitting} type="submit">
            <LogIn size={17} />
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
          <p className="auth-version">Version 1.26.1</p>
        </form>
      </section>
    </main>
  )
}

export function ServicePage() {
  const users = useAuthStore((state) => state.users)
  const roles = useAuthStore((state) => state.roles)
  const saveUser = useAuthStore((state) => state.saveUser)
  const deleteUser = useAuthStore((state) => state.deleteUser)
  const saveRole = useAuthStore((state) => state.saveRole)
  const deleteRole = useAuthStore((state) => state.deleteRole)
  const loadServiceData = useAuthStore((state) => state.loadServiceData)
  const saveServiceConfig = useAuthStore((state) => state.saveServiceConfig)
  const serviceError = useAuthStore((state) => state.serviceError)
  const serviceConfig = useAuthStore((state) => state.serviceConfig)
  const monitoring = useAuthStore((state) => state.monitoring)
  const logout = useAuthStore((state) => state.logout)
  const currentUser = useCurrentUser()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<'users' | 'roles' | 'api' | 'monitoring'>('users')
  const [editingUser, setEditingUser] = useState<Partial<AuthUser> & { password?: string } | null>(null)
  const [editingRole, setEditingRole] = useState<Partial<AuthRole> | null>(null)
  const [configDraft, setConfigDraft] = useState<ServiceConfig>({ risHeaderName: 'RIS-Vexa-Mobilesec', risSharedSecret: 'Velomobile987397497987#$@$', risLaunchTtlSeconds: 60 })
  const [message, setMessage] = useState('')

  useEffect(() => {
    void loadServiceData()
  }, [loadServiceData])

  useEffect(() => {
    if (serviceConfig) {
      setConfigDraft(serviceConfig)
    }
  }, [serviceConfig])

  useEffect(() => {
    if (activeTab !== 'monitoring') return
    const timer = window.setInterval(() => {
      void loadServiceData()
    }, 10000)

    return () => window.clearInterval(timer)
  }, [activeTab, loadServiceData])

  function showError(error: unknown) {
    setMessage(error instanceof Error ? error.message : 'Changes could not be saved.')
  }

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingUser) return
    try {
      await saveUser({
        id: editingUser.id,
        username: editingUser.username ?? '',
        fullName: editingUser.fullName ?? '',
        password: editingUser.password,
        roleIds: editingUser.roleIds ?? [],
        active: editingUser.active ?? true,
      })
      setEditingUser(null)
      setMessage('User saved.')
    } catch (error) {
      showError(error)
    }
  }

  async function submitRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingRole) return
    try {
      await saveRole({
        id: editingRole.id,
        name: editingRole.name ?? '',
        description: editingRole.description ?? '',
        permissions: editingRole.permissions ?? [],
        seriesPolicy: editingRole.seriesPolicy ?? {},
      })
      setEditingRole(null)
      setMessage('Role saved.')
    } catch (error) {
      showError(error)
    }
  }

  async function submitServiceConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await saveServiceConfig(configDraft)
      setMessage('API key configuration saved.')
    } catch (error) {
      showError(error)
    }
  }

  return (
    <main className="service-page">
      <header className="service-header">
        <div>
          <p className="auth-eyebrow">Viewer Service</p>
          <h1>Access Management</h1>
        </div>
        <div className="service-header-actions">
          <span><UserRound size={16} />{currentUser?.fullName}</span>
          <button type="button" title="Back to viewer" onClick={() => navigate('/view')}><ArrowLeft size={17} /></button>
          <button type="button" title="Sign out" onClick={() => { void logout().then(() => navigate('/login', { replace: true })) }}><LogOut size={17} /></button>
        </div>
      </header>

      <section className="service-workspace">
        <nav className="service-tabs" aria-label="Service sections">
          <button className={activeTab === 'users' ? 'active' : ''} type="button" onClick={() => setActiveTab('users')}><UsersRound size={17} />Users</button>
          <button className={activeTab === 'roles' ? 'active' : ''} type="button" onClick={() => setActiveTab('roles')}><ShieldCheck size={17} />Roles & Permissions</button>
          <button className={activeTab === 'api' ? 'active' : ''} type="button" onClick={() => setActiveTab('api')}><KeyRound size={17} />API Key</button>
          <button className={activeTab === 'monitoring' ? 'active' : ''} type="button" onClick={() => setActiveTab('monitoring')}><Activity size={17} />Monitoring</button>
        </nav>

        {(message || serviceError) && <div className="service-message">{message || serviceError}<button type="button" aria-label="Dismiss message" onClick={() => setMessage('')}><X size={14} /></button></div>}

        {activeTab === 'users' ? (
          <section className="service-panel">
            <header>
              <div><h2>Users</h2><p>Viewer identities and assigned clinical roles.</p></div>
              <button className="service-primary-button" type="button" onClick={() => setEditingUser({ active: true, roleIds: [] })}><Plus size={16} />Add User</button>
            </header>
            <div className="service-table-wrap">
              <table className="service-table">
                <thead><tr><th>Full Name</th><th>Username</th><th>Roles</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.fullName}</td>
                      <td>{user.username}</td>
                      <td>{roles.filter((role) => user.roleIds.includes(role.id)).map((role) => role.name).join(', ') || '-'}</td>
                      <td><span className={user.active ? 'service-status active' : 'service-status'}>{user.active ? 'Active' : 'Disabled'}</span></td>
                      <td className="service-row-actions">
                        <button type="button" onClick={() => setEditingUser({ ...user, password: '' })}>Edit</button>
                        <button type="button" title="Delete user" aria-label={`Delete ${user.username}`} onClick={() => { void deleteUser(user.id).catch(showError) }}><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : activeTab === 'roles' ? (
          <section className="service-panel">
            <header>
              <div><h2>Roles & Permissions</h2><p>Feature access is granted through roles.</p></div>
              <button className="service-primary-button" type="button" onClick={() => setEditingRole({ permissions: [], seriesPolicy: {} })}><Plus size={16} />Add Role</button>
            </header>
            <div className="service-role-grid">
              {roles.map((role) => (
                <article className="service-role-card" key={role.id}>
                  <header><div><h3>{role.name}</h3><p>{role.description || 'No description'}</p></div><strong>{role.permissions.length}</strong></header>
                  <div className="service-policy-summary">{formatSeriesPolicySummary(role)}</div>
                  <footer>
                    <button type="button" onClick={() => setEditingRole({ ...role })}>Edit permissions</button>
                    <button type="button" title="Delete role" aria-label={`Delete ${role.name}`} onClick={() => { void deleteRole(role.id).catch(showError) }}><Trash2 size={15} /></button>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        ) : activeTab === 'api' ? (
          <section className="service-panel">
            <header>
              <div><h2>RIS Launch API Key</h2><p>Shared secret for the viewer launch endpoint called by the RIS.</p></div>
            </header>
            <form className="service-config-form" onSubmit={submitServiceConfig}>
              <label>
                <span>Header name</span>
                <input
                  autoComplete="off"
                  value={configDraft.risHeaderName}
                  onChange={(event) => setConfigDraft({ ...configDraft, risHeaderName: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>Shared secret</span>
                <input
                  autoComplete="off"
                  value={configDraft.risSharedSecret}
                  onChange={(event) => setConfigDraft({ ...configDraft, risSharedSecret: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>Launch token TTL (seconds)</span>
                <input readOnly value={configDraft.risLaunchTtlSeconds} />
              </label>
              <div className="service-config-note">
                <strong>Header RIS</strong>
                <code>{configDraft.risHeaderName || 'RIS-Vexa-Mobilesec'}: {configDraft.risSharedSecret || '-'}</code>
              </div>
              <footer><button className="service-primary-button" type="submit"><Check size={16} />Save API Key</button></footer>
            </form>
          </section>
        ) : (
          <section className="service-panel">
            <header>
              <div>
                <h2>Monitoring</h2>
                <p>Current concurrent users and active browser sessions.</p>
              </div>
              <button className="service-primary-button" type="button" onClick={() => { void loadServiceData() }}><RefreshCw size={16} />Refresh</button>
            </header>
            <div className="service-monitor-summary">
              <article><span>CCU</span><strong>{monitoring?.concurrentUsers ?? 0}</strong></article>
              <article><span>Active sessions</span><strong>{monitoring?.activeSessions.length ?? 0}</strong></article>
            </div>
            <div className="service-table-wrap">
              <table className="service-table">
                <thead><tr><th>Account</th><th>IP</th><th>Browser</th><th>Last Seen</th><th>Session Start</th></tr></thead>
                <tbody>
                  {monitoring?.activeSessions.length ? monitoring.activeSessions.map((session) => (
                    <tr key={session.id}>
                      <td><strong>{session.fullName}</strong><small>{session.username}</small></td>
                      <td>{session.ipAddress}</td>
                      <td title={session.userAgent}>{session.browser}</td>
                      <td>{formatServiceDateTime(session.lastSeenAt)}</td>
                      <td>{formatServiceDateTime(session.createdAt)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5}>No active sessions.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </section>

      {editingUser && <UserDialog draft={editingUser} roles={roles} onChange={setEditingUser} onClose={() => setEditingUser(null)} onSubmit={submitUser} />}
      {editingRole && <RoleDialog draft={editingRole} onChange={setEditingRole} onClose={() => setEditingRole(null)} onSubmit={submitRole} />}
    </main>
  )
}

function formatServiceDateTime(value: string) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value))
}

function UserDialog({ draft, roles, onChange, onClose, onSubmit }: { draft: Partial<AuthUser> & { password?: string }; roles: AuthRole[]; onChange: (draft: Partial<AuthUser> & { password?: string }) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <div className="service-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="service-dialog" onSubmit={onSubmit}>
        <header><div><p className="auth-eyebrow">User Account</p><h2>{draft.id ? 'Edit User' : 'Add User'}</h2></div><button type="button" title="Close" onClick={onClose}><X size={17} /></button></header>
        <label><span>Full name</span><input value={draft.fullName ?? ''} onChange={(event) => onChange({ ...draft, fullName: event.currentTarget.value })} /></label>
        <label><span>Username</span><input autoComplete="off" value={draft.username ?? ''} onChange={(event) => onChange({ ...draft, username: event.currentTarget.value })} /></label>
        <label><span>{draft.id ? 'New password (optional)' : 'Password'}</span><input autoComplete="new-password" type="password" value={draft.password ?? ''} onChange={(event) => onChange({ ...draft, password: event.currentTarget.value })} /></label>
        <fieldset><legend>Roles</legend>{roles.map((role) => <label className="service-check-row" key={role.id}><input checked={draft.roleIds?.includes(role.id) ?? false} type="checkbox" onChange={(event) => onChange({ ...draft, roleIds: event.currentTarget.checked ? [...draft.roleIds ?? [], role.id] : draft.roleIds?.filter((roleId) => roleId !== role.id) })} /><span>{role.name}</span></label>)}</fieldset>
        <label className="service-check-row"><input checked={draft.active ?? true} type="checkbox" onChange={(event) => onChange({ ...draft, active: event.currentTarget.checked })} /><span>Account active</span></label>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="service-primary-button" type="submit"><Check size={16} />Save User</button></footer>
      </form>
    </div>
  )
}

function RoleDialog({ draft, onChange, onClose, onSubmit }: { draft: Partial<AuthRole>; onChange: (draft: Partial<AuthRole>) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const permissionGroups = [...new Set(permissions.map((permission) => permission.group))]
  const maxImagesPerSeries = draft.seriesPolicy?.maxImagesPerSeries
  const blockedModalities = draft.seriesPolicy?.blockedModalities ?? []
  function togglePermission(permission: PermissionId, checked: boolean) {
    onChange({ ...draft, permissions: checked ? [...draft.permissions ?? [], permission] : draft.permissions?.filter((item) => item !== permission) })
  }
  function updateMaxImagesPerSeries(value: string) {
    const parsedValue = Number(value)
    onChange({
      ...draft,
      seriesPolicy: {
        ...draft.seriesPolicy,
        maxImagesPerSeries: Number.isFinite(parsedValue) && parsedValue > 0 ? Math.floor(parsedValue) : undefined,
      },
    })
  }
  function updateBlockedModalities(value: string) {
    onChange({
      ...draft,
      seriesPolicy: {
        ...draft.seriesPolicy,
        blockedModalities: parseModalities(value),
      },
    })
  }
  return (
    <div className="service-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="service-dialog service-role-dialog" onSubmit={onSubmit}>
        <header><div><p className="auth-eyebrow">Role Policy</p><h2>{draft.id ? 'Edit Role' : 'Add Role'}</h2></div><button type="button" title="Close" onClick={onClose}><X size={17} /></button></header>
        <label><span>Role name</span><input value={draft.name ?? ''} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })} /></label>
        <label><span>Description</span><input value={draft.description ?? ''} onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })} /></label>
        <fieldset className="service-series-policy">
          <legend>Series access rules</legend>
          <label>
            <span>Max images per series</span>
            <input
              min={1}
              placeholder="No limit"
              type="number"
              value={maxImagesPerSeries ?? ''}
              onChange={(event) => updateMaxImagesPerSeries(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Blocked modalities</span>
            <input
              autoCapitalize="characters"
              placeholder="RAW, OT, SR"
              value={blockedModalities.join(', ')}
              onChange={(event) => updateBlockedModalities(event.currentTarget.value)}
            />
          </label>
        </fieldset>
        <div className="service-permission-list">
          {permissionGroups.map((group) => <fieldset key={group}><legend>{group}</legend>{permissions.filter((permission) => permission.group === group).map((permission) => <label className="service-check-row" key={permission.id}><input checked={draft.permissions?.includes(permission.id) ?? false} type="checkbox" onChange={(event) => togglePermission(permission.id, event.currentTarget.checked)} /><span>{permission.label}</span></label>)}</fieldset>)}
        </div>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="service-primary-button" type="submit"><Check size={16} />Save Role</button></footer>
      </form>
    </div>
  )
}

function parseModalities(value: string) {
  return [...new Set(value
    .split(/[\s,;]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))]
}

function formatSeriesPolicySummary(role: AuthRole) {
  const limits = [
    role.seriesPolicy?.maxImagesPerSeries ? `Max ${role.seriesPolicy.maxImagesPerSeries} images/series` : '',
    role.seriesPolicy?.blockedModalities?.length ? `Blocked: ${role.seriesPolicy.blockedModalities.join(', ')}` : '',
  ].filter(Boolean)

  return limits.join(' | ') || 'No series restrictions'
}
