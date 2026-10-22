import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const dataPath = process.env.NEXIA_AUTH_DB ?? join(process.cwd(), 'server', 'data', 'auth-db.json')
const cookieName = process.env.NEXIA_SESSION_COOKIE_NAME ?? 'vexa_desktop_session'
const sessionTtlDays = Number(process.env.NEXIA_SESSION_TTL_DAYS ?? 1000)
const sessionTtlMs = sessionTtlDays * 24 * 60 * 60 * 1000
const risLaunchTtlMs = Number(process.env.NEXIA_RIS_LAUNCH_TTL_SECONDS ?? 60) * 1000
const risConsumeRedirectPath = process.env.NEXIA_RIS_CONSUME_REDIRECT_PATH ?? '/view'
const defaultRisHeaderName = 'RIS-Desktop-Sec'
const defaultRisSharedSecret = 'Velodesktopview89287579@#VEXA@'
const passwordKeyLength = 64
const currentRolePermissionSchemaVersion = 3
const viewerOverlayCorners = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']
const defaultViewerOverlayLayout = {
  topLeft: ['patientName', 'patientId'],
  topRight: ['modalityStudy', 'seriesInfo', 'studyDateTime', 'accessionNumber'],
  bottomLeft: ['laterality', 'viewPosition', 'patientPosition', 'page'],
  bottomRight: ['sliceLocation', 'sliceThickness', 'sliceSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber'],
}
const viewerOverlayDefaultProfileId = 'DEFAULT'
// DICOM PS3.16 2026c CID 33, plus current PS3.3 RT Second Generation,
// XA Protocol, and retired compatibility values for legacy studies.
const viewerOverlayModalityCodes = new Set(`
  CT MR NM PT CR DX MG IO PX RG RF XA RTIMAGE US BDUS ES PA TG BI BMD DG
  AR CFM DMS GM IVOCT IVUS KER LEN LS OAM OCT OP OPM OPT OPTBSV OPTENF OPV OSS SM SRF VA XC
  ECG EEG EMG EOG EPS HD POS RESP
  ASMT AU CTPROTOCOL DOC FID HC IOL KO M3D OT PLAN PR REG RTDOSE RTINTENT RTPLAN RTRAD RTRECORD RTSEGANN RTSTRUCT RWV SEG SMR SR STAIN TEXTUREMAP XAPROTOCOL
  AS CD CF CP CS DD DF DM DS EC FA FS LP MA MS OPR ST VF
`.trim().split(/\s+/))
const viewerOverlayFieldIds = new Set([
  'patientName', 'patientId', 'birthDate', 'sex', 'age', 'weight', 'patientSize', 'patientPosition',
  'modalityStudy', 'studyDateTime', 'studyDescription', 'accessionNumber', 'studyId', 'referringPhysician', 'institutionName', 'modalitiesInStudy', 'studyUid',
  'seriesInfo', 'seriesNumber', 'seriesDateTime', 'protocolName', 'bodyPart', 'laterality', 'viewPosition', 'imageType', 'manufacturer', 'modelName', 'stationName', 'operatorName', 'seriesUid',
  'kvp', 'tubeCurrent', 'exposureTime', 'exposure', 'ctdiVol', 'pitch', 'kernel', 'gantryTilt', 'rotationTime', 'totalCollimationWidth', 'tableFeedPerRotation', 'dataCollectionDiameter', 'filterType', 'contrastAgent', 'scanOptions', 'acquisitionNumber',
  'tr', 'te', 'ti', 'flipAngle', 'fieldStrength', 'scanningSequence', 'sequenceVariant', 'mrAcquisitionType', 'sequenceName', 'echoNumber', 'echoTrainLength', 'imagingFrequency', 'imagedNucleus', 'phaseEncodingDirection', 'acquisitionMatrix', 'triggerTime',
  'detectorType', 'exposureIndex', 'targetExposureIndex', 'deviationIndex', 'primaryAngle', 'secondaryAngle', 'sourceToDetectorDistance', 'sourceToPatientDistance', 'tableHeight',
  'transducerData', 'transducerFrequency', 'scanFieldDepth', 'mechanicalIndex', 'boneThermalIndex',
  'radiopharmaceutical', 'radionuclide', 'radionuclideTotalDose', 'radionuclideHalfLife', 'radiopharmaceuticalStartTime', 'petUnits', 'decayCorrection', 'suvType', 'waveformSamplingFrequency',
  'sliceLocation', 'sliceThickness', 'sliceSpacing', 'reconDiameter', 'imagePosition', 'imageOrientation', 'pixelSpacing', 'matrix', 'bitsStored', 'photometric', 'presentationIntent', 'rescaleIntercept', 'rescaleSlope',
  'windowCenter', 'windowWidth', 'zoom', 'page', 'imageNumber', 'sopInstanceUid', 'frameOfReferenceUid',
])
const allPermissionIds = [
  'service.manage',
  'study.view',
  'study.view_related_history',
  'viewer.layout.change',
  'viewer.series.drag_drop',
  'viewer.intellilink.use',
  'viewer.export.use',
  'settings.toolbar.customize',
  'settings.appearance.customize',
  'settings.hotkeys.customize',
  'tool.navigation.use',
  'tool.window_level.use',
  'tool.preset.use',
  'tool.measurement.use',
  'tool.annotation.use',
  'tool.orientation.use',
  'tool.overlay.toggle',
  'tool.reference_lines.use',
  'ich.segmentation.use',
  'ich.segmentation.save',
  'ich.cine.export',
  'dicom.upload',
  'mpr.open',
  'mpr.bone_3d.open',
  'mpr.cursor_3d.use',
  'mpr.crosshair.use',
  'mpr.reformat_tools.use',
  'dicom_tags.view',
]

const defaultRoles = [
  {
    id: 'role-admin',
    name: 'ADMINISTRATOR',
    description: 'Full access, including user and role administration.',
    permissions: allPermissionIds,
    seriesPolicy: {},
  },
  {
    id: 'role-technologist',
    name: 'TECHNOLOGIST',
    description: 'Acquisition and workflow access for technologists.',
    permissions: allPermissionIds.filter((permission) => permission !== 'service.manage' && !permission.startsWith('ich.')),
    seriesPolicy: {},
  },
  {
    id: 'role-medical-physics',
    name: 'MEDICAL PHYSICS',
    description: 'Quality and dose review access.',
    permissions: allPermissionIds.filter((permission) => permission !== 'service.manage' && !permission.startsWith('ich.')),
    seriesPolicy: {},
  },
  {
    id: 'role-radiologist',
    name: 'RADIOLOGIST',
    description: 'Diagnostic reading access with advanced tools.',
    permissions: allPermissionIds.filter((permission) => permission !== 'service.manage'),
    seriesPolicy: {},
  },
  {
    id: 'role-clinician',
    name: 'CLINICIAN',
    description: 'General image review without advanced reformat tools.',
    permissions: [
      'study.view',
      'study.view_related_history',
      'viewer.layout.change',
      'viewer.series.drag_drop',
      'tool.navigation.use',
      'tool.window_level.use',
      'tool.preset.use',
      'tool.overlay.toggle',
    ],
    seriesPolicy: {},
  },
]

export async function authorizeViewerRequest(req, requiredPermission = 'study.view') {
  const db = await readDb()
  cleanExpiredSessions(db)
  const session = getSession(req, db)
  if (!session) return null

  const payload = buildSessionPayload(db, session.userId)
  if (requiredPermission && !payload.permissions.includes(requiredPermission)) {
    return null
  }

  return payload
}

export async function handleAuthApi(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  url.pathname = normalizeAuthPath(url.pathname)
  if (!url.pathname.startsWith('/api/auth')) return false

  try {
    if (!isSafeRequest(req) && !isTrustedOrigin(req)) {
      sendJson(res, 403, { error: 'Invalid request origin.' })
      return true
    }

    const db = await readDb()
    cleanExpiredSessions(db)

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const session = getSession(req, db)
      sendJson(res, 200, buildSessionPayload(db, session?.userId))
      await writeDb(db)
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson(req)
      const user = db.users.find((candidate) => candidate.username.toLowerCase() === String(body.username ?? '').trim().toLowerCase())
      if (!user || !user.active || !(await verifyPassword(String(body.password ?? ''), user.passwordHash))) {
        sendJson(res, 401, { error: 'Incorrect username or password.' })
        return true
      }

      const rawToken = createSession(db, user.id, null, req)
      await writeDb(db)
      setSessionCookie(res, rawToken, req)
      sendJson(res, 200, buildSessionPayload(db, user.id))
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/ris/launch') {
      if (!isValidRisSecret(req, db)) {
        sendJson(res, 401, { error: 'Invalid RIS launch secret.' })
        return true
      }

      const body = await readJson(req)
      const user = await upsertRisUser(db, body.user ?? body)
      const launchToken = randomBytes(32).toString('base64url')
      const viewerContext = buildViewerContext(body)
      if (!viewerContext.accession && !viewerContext.studyUID) {
        sendJson(res, 400, { error: 'A RIS launch must include an Accession Number or StudyInstanceUID.' })
        return true
      }
      db.launchTokens.push({
        id: randomUUID(),
        tokenHash: hashToken(launchToken),
        userId: user.id,
        viewerContext,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + risLaunchTtlMs).toISOString(),
      })
      await writeDb(db)
      sendJson(res, 200, {
        launchUrl: `${getRequestOrigin(req)}/Viewer?launch=${encodeURIComponent(launchToken)}`,
        expiresInSeconds: Math.floor(risLaunchTtlMs / 1000),
      })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/ris/consume') {
      const launchToken = url.searchParams.get('token') ?? ''
      const launch = consumeLaunchToken(db, launchToken)
      if (!launch) {
        await writeDb(db)
        redirect(res, '/login')
        return true
      }

      const rawToken = createSession(db, launch.userId, launch.viewerContext ?? parseViewerContextFromPath(launch.viewerPath), req)
      await writeDb(db)
      setSessionCookie(res, rawToken, req)
      redirect(res, risConsumeRedirectPath)
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/ris/consume-json') {
      const body = await readJson(req)
      const launchToken = String(body.token ?? '').trim()
      const launch = consumeLaunchToken(db, launchToken)
      if (!launch) {
        await writeDb(db)
        sendJson(res, 401, { error: 'Invalid or expired launch token.' })
        return true
      }

      const rawToken = createSession(db, launch.userId, launch.viewerContext ?? parseViewerContextFromPath(launch.viewerPath), req)
      await writeDb(db)
      setSessionCookie(res, rawToken, req)
      sendJson(res, 200, { ok: true, redirectTo: '/view' })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = readCookie(req, cookieName)
      if (token) {
        const tokenHash = hashToken(token)
        db.sessions = db.sessions.filter((session) => session.tokenHash !== tokenHash)
        await writeDb(db)
      }
      clearSessionCookie(res)
      sendJson(res, 200, { ok: true })
      return true
    }

    const session = getSession(req, db)
    if (!session) {
      sendJson(res, 401, { error: 'Unauthorized.' })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/service') {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }
      sendJson(res, 200, {
        users: db.users.map(publicUser),
        roles: db.roles,
        config: publicServiceConfig(db),
        monitoring: buildMonitoringPayload(db),
      })
      await writeDb(db)
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/service/config') {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }

      const body = await readJson(req)
      db.settings = sanitizeServiceConfig(body)
      await writeDb(db)
      sendJson(res, 200, {
        config: publicServiceConfig(db),
        monitoring: buildMonitoringPayload(db),
      })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/preferences') {
      const user = db.users.find((item) => item.id === session.userId)
      sendJson(res, 200, user?.preferences ?? {})
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/viewer-launch') {
      sendJson(res, 200, { viewerContext: session.viewerContext ?? null })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/viewer-presence') {
      try {
        const body = await readJson(req).catch(() => ({}))
        updateViewerPresence(db, session, req, String(body.state ?? 'active'))
        await writeDb(db)
        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 200, { ok: false, ignored: true })
      }
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/preferences') {
      try {
        const user = db.users.find((item) => item.id === session.userId)
        if (!user) {
          sendJson(res, 401, { error: 'Unauthorized.' })
          return true
        }
        const body = await readJson(req).catch(() => ({}))
        user.preferences = sanitizePreferences(body, user.preferences ?? {})
        await writeDb(db)
        sendJson(res, 200, user.preferences)
      } catch (error) {
        sendJson(res, 200, { ok: false, ignored: true, error: error instanceof Error ? error.message : 'Unable to save preferences.' })
      }
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/users') {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }
      const body = await readJson(req)
      const user = await upsertUser(db, body)
      await writeDb(db)
      sendJson(res, 200, { user: publicUser(user), users: db.users.map(publicUser), roles: db.roles })
      return true
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/auth/users/')) {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }
      const userId = decodeURIComponent(url.pathname.slice('/api/auth/users/'.length))
      if (userId === session.userId) {
        sendJson(res, 400, { error: 'The account currently in use cannot be deleted.' })
        return true
      }
      db.users = db.users.filter((user) => user.id !== userId)
      db.sessions = db.sessions.filter((item) => item.userId !== userId)
      await writeDb(db)
      sendJson(res, 200, { users: db.users.map(publicUser), roles: db.roles })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/roles') {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }
      const body = await readJson(req)
      const role = upsertRole(db, body)
      await writeDb(db)
      sendJson(res, 200, { role, users: db.users.map(publicUser), roles: db.roles })
      return true
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/auth/roles/')) {
      if (!hasPermission(db, session.userId, 'service.manage')) {
        sendJson(res, 403, { error: 'Forbidden.' })
        return true
      }
      const roleId = decodeURIComponent(url.pathname.slice('/api/auth/roles/'.length))
      if (db.users.some((user) => user.roleIds.includes(roleId))) {
        sendJson(res, 400, { error: 'The role is still assigned to users.' })
        return true
      }
      db.roles = db.roles.filter((role) => role.id !== roleId)
      await writeDb(db)
      sendJson(res, 200, { users: db.users.map(publicUser), roles: db.roles })
      return true
    }

    sendJson(res, 404, { error: 'Not found.' })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Auth server error.' })
  }

  return true
}

function normalizeAuthPath(pathname) {
  return String(pathname || '/').replace(/^\/viewer(?=\/api\/auth(?:\/|$))/i, '') || '/'
}

async function readDb() {
  try {
    const db = JSON.parse(await readFile(dataPath, 'utf8'))
    const roles = mergeDefaultRoles(Array.isArray(db.roles) ? db.roles.map(migrateRolePermissions) : [])
    return {
      users: Array.isArray(db.users) ? db.users : [],
      roles,
      sessions: Array.isArray(db.sessions) ? db.sessions : [],
      launchTokens: Array.isArray(db.launchTokens) ? db.launchTokens : [],
      viewerPresence: Array.isArray(db.viewerPresence) ? db.viewerPresence : [],
      settings: sanitizeServiceConfig(db.settings ?? {}),
    }
  } catch {
    const passwordHash = await hashPassword('admin123')
    const db = {
      users: [{
        id: 'user-admin',
        username: 'admin',
        fullName: 'VEXA Administrator',
        passwordHash,
        roleIds: ['role-admin'],
        active: true,
      }],
      roles: defaultRoles,
      sessions: [],
      launchTokens: [],
      viewerPresence: [],
      settings: sanitizeServiceConfig({}),
    }
    await writeDb(db)
    return db
  }
}

function migrateRolePermissions(role) {
  const permissions = Array.isArray(role.permissions)
    ? role.permissions.filter((permission) => allPermissionIds.includes(permission))
    : []
  const seriesPolicy = sanitizeSeriesPolicy(role.seriesPolicy)
  const permissionSchemaVersion = Number(role.permissionSchemaVersion) || 0
  const migratedPermissions = permissionSchemaVersion < 3 && permissions.includes('tool.annotation.use')
    ? [...new Set([...permissions, 'viewer.export.use'])]
    : permissions

  if (role.id === 'role-admin') {
    return { ...role, permissionSchemaVersion: currentRolePermissionSchemaVersion, permissions: allPermissionIds, seriesPolicy }
  }
  if (role.id === 'role-radiologist' && permissionSchemaVersion < currentRolePermissionSchemaVersion) {
    const radiologistPermissions = ['dicom.upload', 'ich.segmentation.use', 'ich.segmentation.save', 'ich.cine.export']
    return {
      ...role,
      permissionSchemaVersion: currentRolePermissionSchemaVersion,
      permissions: [...new Set([...migratedPermissions, ...radiologistPermissions])],
      seriesPolicy,
    }
  }

  return { ...role, permissionSchemaVersion: currentRolePermissionSchemaVersion, permissions: migratedPermissions, seriesPolicy }
}

function mergeDefaultRoles(roles) {
  const byId = new Map(defaultRoles.map((role) => [role.id, role]))
  for (const role of roles) byId.set(role.id, migrateRolePermissions({ ...byId.get(role.id), ...role }))
  return [...byId.values()].map(migrateRolePermissions)
}

async function upsertRisUser(db, body) {
  const externalId = String(body.externalUserId ?? body.username ?? '').trim().toLowerCase()
  const username = String(body.username ?? externalId).trim().toLowerCase()
  const fullName = String(body.fullName ?? body.name ?? username).trim()
  const roleIds = resolveRisRoleIds(db, body)
  if (!username || !fullName) throw new Error('A RIS user must have a username/externalUserId and fullName.')

  const index = db.users.findIndex((user) => user.externalUserId === externalId || user.username.toLowerCase() === username)
  const existing = db.users[index]
  const passwordHash = existing?.passwordHash ?? await hashPassword(randomBytes(32).toString('base64url'))
  const user = {
    id: existing?.id ?? `user-${randomUUID()}`,
    username,
    fullName,
    passwordHash,
    roleIds,
    active: true,
    preferences: existing?.preferences ?? {},
    externalUserId: externalId || undefined,
  }
  if (index >= 0) db.users[index] = user
  else db.users.push(user)
  return user
}

function resolveRisRoleIds(db, body) {
  const externalId = String(body.externalUserId ?? '').trim().toLowerCase()
  const username = String(body.username ?? body.externalUserId ?? '').trim().toLowerCase()
  const existing = db.users.find((user) => user.externalUserId === externalId || user.username.toLowerCase() === username)
  if (existing?.roleIds.length) return existing.roleIds
  const role = String(body.role ?? body.userRole ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  if (role === 'administrator' || role === 'admin') return ['role-admin']
  if (role === 'technologist') return ['role-technologist']
  if (role === 'medical_physics' || role === 'fismed') return ['role-medical-physics']
  if (role === 'radiologist') return ['role-radiologist']
  return ['role-clinician']
}

function buildViewerContext(body) {
  return sanitizeViewerContext({
    studyUID: pickFirst(body, ['studyUID', 'studyUid', 'StudyInstanceUID', 'StudyInstanceUIDs', 'study_instance_uid']),
    seriesUID: pickFirst(body, ['seriesUID', 'seriesUid', 'SeriesInstanceUID', 'series_instance_uid']),
    accession: pickFirst(body, ['accession', 'accessionNumber', 'AccessionNumber', 'accessionNo', 'accession_number', 'accession_no', 'noAccession']),
    patientId: pickFirst(body, ['patientId', 'patientID', 'PatientID', 'patient_id', 'medicalRecordNumber', 'mrn']),
    mode: pickFirst(body, ['mode', 'viewerMode']),
  })
}

function parseViewerContextFromPath(viewerPath) {
  if (!viewerPath) return null
  try {
    const url = new URL(String(viewerPath), 'http://localhost')
    return sanitizeViewerContext({
      studyUID: url.searchParams.get('studyUID'),
      seriesUID: url.searchParams.get('seriesUID'),
      accession: url.searchParams.get('accession'),
      patientId: url.searchParams.get('patientId'),
      mode: url.searchParams.get('mode'),
    })
  } catch {
    return null
  }
}

function launchPayloadCandidates(body) {
  if (!body || typeof body !== 'object') return []
  const candidates = [
    body,
    body?.viewer,
    body?.viewerContext,
    body?.context,
    body?.payload,
    body?.study,
    body?.order,
    body?.ris,
  ].filter((item) => item && typeof item === 'object')

  return candidates
}

function pickFirst(body, keys) {
  for (const source of launchPayloadCandidates(body)) {
    for (const key of keys) {
      const value = source?.[key]
      if (value !== undefined && value !== null && String(value).trim()) {
        return value
      }
    }
  }
  return ''
}

function sanitizeViewerContext(context) {
  const mode = String(context.mode ?? '').trim()
  const viewerContext = {
    studyUID: String(context.studyUID ?? '').trim(),
    seriesUID: String(context.seriesUID ?? '').trim(),
    accession: String(context.accession ?? '').trim(),
    patientId: String(context.patientId ?? '').trim(),
    mode: mode === 'mpr' || mode === 'stack' ? mode : 'stack',
  }
  return Object.fromEntries(Object.entries(viewerContext).filter(([, value]) => value))
}

function createSession(db, userId, viewerContext = null, req = null) {
  const rawToken = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const clientKey = req ? getSessionClientKey(userId, req) : ''
  if (clientKey) {
    db.sessions = db.sessions.filter((session) => session.clientKey !== clientKey)
  }
  db.sessions.push({
    id: randomUUID(),
    userId,
    tokenHash: hashToken(rawToken),
    clientKey,
    viewerContext,
    createdAt: now,
    lastSeenAt: now,
    ipAddress: req ? getRequestIp(req) : '',
    userAgent: req ? getRequestUserAgent(req) : '',
    expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
  })
  return rawToken
}

function consumeLaunchToken(db, launchToken) {
  const tokenHash = hashToken(launchToken)
  const launch = db.launchTokens.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now())
  db.launchTokens = db.launchTokens.filter((item) => item.tokenHash !== tokenHash)

  if (!launch || !db.users.some((user) => user.id === launch.userId && user.active)) {
    return null
  }

  return launch
}

async function writeDb(db) {
  await mkdir(dirname(dataPath), { recursive: true })
  const tempPath = `${dataPath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  await rename(tempPath, dataPath)
}

async function upsertUser(db, body) {
  const username = String(body.username ?? '').trim().toLowerCase()
  const fullName = String(body.fullName ?? '').trim()
  const roleIds = Array.isArray(body.roleIds) ? body.roleIds.filter((roleId) => db.roles.some((role) => role.id === roleId)) : []
  const active = body.active !== false
  if (!username || !fullName) throw new Error('Username and full name are required.')
  if (db.users.some((user) => user.id !== body.id && user.username.toLowerCase() === username)) throw new Error('That username is already taken.')
  const index = db.users.findIndex((user) => user.id === body.id)
  const existing = db.users[index]
  if (!existing && !body.password) throw new Error('A password is required for a new user.')
  const passwordHash = body.password ? await hashPassword(String(body.password)) : existing.passwordHash
  const user = { id: existing?.id ?? `user-${randomUUID()}`, username, fullName, passwordHash, roleIds, active, preferences: existing?.preferences ?? {} }
  if (index >= 0) db.users[index] = user
  else db.users.push(user)
  return user
}

function upsertRole(db, body) {
  const name = String(body.name ?? '').trim()
  const description = String(body.description ?? '').trim()
  const nextPermissions = Array.isArray(body.permissions) ? body.permissions.filter((permission) => allPermissionIds.includes(permission)) : []
  const seriesPolicy = sanitizeSeriesPolicy(body.seriesPolicy)
  if (!name) throw new Error('Role name is required.')
  const index = db.roles.findIndex((role) => role.id === body.id)
  const role = { id: db.roles[index]?.id ?? `role-${randomUUID()}`, name, description, permissionSchemaVersion: currentRolePermissionSchemaVersion, permissions: nextPermissions, seriesPolicy }
  if (index >= 0) db.roles[index] = role
  else db.roles.push(role)
  return role
}

function sanitizeSeriesPolicy(policy) {
  const rawMaxImages = Number(policy?.maxImagesPerSeries)
  const maxImagesPerSeries = Number.isFinite(rawMaxImages) && rawMaxImages > 0
    ? Math.floor(Math.min(rawMaxImages, 100000))
    : undefined
  const blockedModalities = Array.isArray(policy?.blockedModalities)
    ? [...new Set(policy.blockedModalities
      .map((modality) => String(modality).trim().toUpperCase())
      .filter((modality) => /^[A-Z0-9]{1,16}$/.test(modality)))]
    : []

  return {
    ...(maxImagesPerSeries ? { maxImagesPerSeries } : {}),
    ...(blockedModalities.length ? { blockedModalities } : {}),
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url')
  const derived = await scrypt(password, salt, passwordKeyLength)
  return `scrypt$${salt}$${Buffer.from(derived).toString('base64url')}`
}

async function verifyPassword(password, passwordHash) {
  const [, salt, expected] = String(passwordHash).split('$')
  if (!salt || !expected) return false
  const derived = await scrypt(password, salt, passwordKeyLength)
  const expectedBuffer = Buffer.from(expected, 'base64url')
  return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived)
}

function getSession(req, db) {
  const token = readCookie(req, cookieName)
  if (!token) return null
  const tokenHash = hashToken(token)
  const session = db.sessions.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now())
  const user = db.users.find((item) => item.id === session?.userId && item.active)
  if (session && user) {
    session.lastSeenAt = new Date().toISOString()
    session.ipAddress = getRequestIp(req)
    session.userAgent = getRequestUserAgent(req)
  }
  return user ? session : null
}

function buildSessionPayload(db, userId) {
  const user = db.users.find((item) => item.id === userId && item.active)
  if (!user) return { user: null, roles: [], permissions: [], viewerOverlay: getViewerOverlayConfig(db) }
  const roles = db.roles.filter((role) => user.roleIds.includes(role.id))
  return {
    user: publicUser(user),
    roles,
    permissions: [...new Set(roles.flatMap((role) => role.permissions))],
    viewerOverlay: getViewerOverlayConfig(db),
  }
}

function hasPermission(db, userId, permission) {
  return buildSessionPayload(db, userId).permissions.includes(permission)
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roleIds: user.roleIds,
    active: user.active,
  }
}

function sanitizePreferences(body, existing = {}) {
  const next = { ...existing }

  if (Array.isArray(body.toolbarFavorites)) {
    next.toolbarFavorites = body.toolbarFavorites.filter((item) => typeof item === 'string')
  }

  if (typeof body.viewerAppearance === 'object' && body.viewerAppearance) {
    const currentAppearance = typeof existing.viewerAppearance === 'object' && existing.viewerAppearance ? existing.viewerAppearance : {}
    const browserPlacement = ['top', 'belowToolbar', 'bottom'].includes(body.viewerAppearance.browserPlacement)
      ? body.viewerAppearance.browserPlacement
      : (['top', 'belowToolbar', 'bottom'].includes(currentAppearance.browserPlacement) ? currentAppearance.browserPlacement : 'top')
    next.viewerAppearance = {
      showToolbar: typeof body.viewerAppearance.showToolbar === 'boolean' ? body.viewerAppearance.showToolbar : true,
      contextMenuEnabled: typeof body.viewerAppearance.contextMenuEnabled === 'boolean' ? body.viewerAppearance.contextMenuEnabled : true,
      browserPanelVisible: typeof body.viewerAppearance.browserPanelVisible === 'boolean' ? body.viewerAppearance.browserPanelVisible : true,
      browserPlacement,
    }
  }

  if (typeof body.hotkeyOverrides === 'object' && body.hotkeyOverrides) {
    next.hotkeyOverrides = Object.fromEntries(
      Object.entries(body.hotkeyOverrides)
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string'),
    )
  }

  if (Array.isArray(body.customWindowPresets)) {
    next.customWindowPresets = sanitizeCustomWindowPresets(body.customWindowPresets)
  }

  if (typeof body.layoutPreferences === 'object' && body.layoutPreferences) {
    const currentLayout = typeof next.layoutPreferences === 'object' && next.layoutPreferences ? next.layoutPreferences : {}
    const layoutPreferences = { ...currentLayout }
    if (Number.isFinite(Number(body.layoutPreferences.headerHeight))) {
      layoutPreferences.headerHeight = Math.min(Math.max(Number(body.layoutPreferences.headerHeight), 120), 320)
    }
    if (Number.isFinite(Number(body.layoutPreferences.studyPanelWidth))) {
      layoutPreferences.studyPanelWidth = Math.min(Math.max(Number(body.layoutPreferences.studyPanelWidth), 220), 720)
    }
    next.layoutPreferences = layoutPreferences
  }

  return next
}

function sanitizeCustomWindowPresets(value) {
  const presets = value
    .map((item) => {
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 48) : ''
      const windowWidth = Math.round(Number(item?.windowWidth))
      const windowLevel = Math.round(Number(item?.windowLevel))
      const fallbackId = name ? `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
      const id = typeof item?.id === 'string' && item.id ? item.id.slice(0, 80) : fallbackId
      if (!id || !name || !Number.isFinite(windowWidth) || !Number.isFinite(windowLevel) || windowWidth <= 0) return null
      return { id, name, windowWidth, windowLevel }
    })
    .filter(Boolean)

  return Array.from(new Map(presets.map((preset) => [preset.name.toLowerCase(), preset])).values())
    .slice(0, 40)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function cleanExpiredSessions(db) {
  const now = Date.now()
  db.sessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now)
  db.launchTokens = (db.launchTokens ?? []).filter((token) => Date.parse(token.expiresAt) > now)
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie ?? '').split(';')
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return ''
}

function setSessionCookie(res, token, req) {
  if (res.headersSent) return
  const secure = shouldUseSecureCookie(req) ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`)
}

function shouldUseSecureCookie(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return forwardedProto === 'https' || Boolean(req?.socket?.encrypted)
}

function clearSessionCookie(res) {
  if (res.headersSent) return
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

function isSafeRequest(req) {
  return req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
}

function isTrustedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function isValidRisSecret(req, db) {
  const provided = String(req.headers[getRisHeaderName(db).toLowerCase()] ?? '')
  const risSharedSecret = getRisSharedSecret(db)
  if (!provided || !risSharedSecret) return false
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(risSharedSecret)
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
}

function publicServiceConfig(db) {
  return {
    risHeaderName: getRisHeaderName(db),
    risSharedSecret: getRisSharedSecret(db),
    risLaunchTtlSeconds: Math.floor(risLaunchTtlMs / 1000),
    viewerOverlay: getViewerOverlayConfig(db),
  }
}

function sanitizeServiceConfig(config) {
  return {
    risHeaderName: sanitizeHeaderName(config?.risHeaderName ?? process.env.VEXA_RIS_HEADER_NAME ?? process.env.NEXIA_RIS_HEADER_NAME ?? defaultRisHeaderName),
    risSharedSecret: String(config?.risSharedSecret ?? process.env.VEXA_RIS_SHARED_SECRET ?? process.env.VEXA_RIS_SHARED_SECRET ?? process.env.NEXIA_RIS_SHARED_SECRET ?? defaultRisSharedSecret).trim(),
    viewerOverlay: sanitizeViewerOverlayConfig(config?.viewerOverlay),
  }
}

function getViewerOverlayConfig(db) {
  return sanitizeViewerOverlayConfig(db.settings?.viewerOverlay)
}

function sanitizeViewerOverlayConfig(config) {
  const sourceProfiles = config && typeof config === 'object' && config.profiles && typeof config.profiles === 'object'
    ? config.profiles
    : null
  const profiles = {}

  if (sourceProfiles) {
    for (const [rawProfileId, sourceLayout] of Object.entries(sourceProfiles)) {
      const profileId = String(rawProfileId ?? '').trim().toUpperCase()
      if (profileId !== viewerOverlayDefaultProfileId && !viewerOverlayModalityCodes.has(profileId)) continue
      profiles[profileId] = sanitizeViewerOverlayLayout(sourceLayout)
    }
  } else if (config && typeof config === 'object' && config.layout) {
    // Migrate the legacy, single global layout to the default fallback profile.
    profiles[viewerOverlayDefaultProfileId] = sanitizeViewerOverlayLayout(config.layout)
  }

  return { version: 2, profiles }
}

function sanitizeViewerOverlayLayout(sourceLayout) {
  const layout = {}
  const source = sourceLayout && typeof sourceLayout === 'object' ? sourceLayout : {}

  for (const corner of viewerOverlayCorners) {
    const sourceFields = Array.isArray(source[corner]) ? source[corner] : defaultViewerOverlayLayout[corner]
    const uniqueFields = []
    for (const value of sourceFields) {
      const id = String(value ?? '')
      if (!viewerOverlayFieldIds.has(id) || uniqueFields.includes(id)) continue
      uniqueFields.push(id)
      if (uniqueFields.length >= 24) break
    }
    layout[corner] = uniqueFields
  }

  return layout
}

function getRisHeaderName(db) {
  return sanitizeHeaderName(process.env.VEXA_RIS_HEADER_NAME ?? process.env.NEXIA_RIS_HEADER_NAME ?? db.settings?.risHeaderName ?? defaultRisHeaderName)
}

function getRisSharedSecret(db) {
  return String(process.env.VEXA_RIS_SHARED_SECRET ?? process.env.VEXA_RIS_SHARED_SECRET ?? process.env.NEXIA_RIS_SHARED_SECRET ?? db.settings?.risSharedSecret ?? defaultRisSharedSecret).trim()
}

function sanitizeHeaderName(headerName) {
  const value = String(headerName ?? '').trim()
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) ? value : defaultRisHeaderName
}

function buildMonitoringPayload(db) {
  const activeCutoff = Date.now() - 30 * 1000
  db.viewerPresence = dedupeActiveSessions((db.viewerPresence ?? []).filter((presence) => Date.parse(presence.lastSeenAt ?? presence.createdAt) >= activeCutoff))
  const activeSessions = db.viewerPresence
  const usersById = new Map(db.users.map((user) => [user.id, user]))

  return {
    concurrentUsers: new Set(activeSessions.map((session) => session.userId)).size,
    activeSessions: activeSessions
      .sort((a, b) => Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt))
      .map((session) => {
        const user = usersById.get(session.userId)
        return {
          id: session.id,
          userId: session.userId,
          username: user?.username ?? '-',
          fullName: user?.fullName ?? '-',
          ipAddress: session.ipAddress ?? '-',
          browser: parseBrowserLabel(session.userAgent ?? ''),
          userAgent: session.userAgent ?? '',
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt ?? session.createdAt,
          expiresAt: session.expiresAt,
        }
      }),
  }
}

function updateViewerPresence(db, session, req, state) {
  db.viewerPresence ??= []
  const clientKey = session.clientKey || getSessionClientKey(session.userId, req)
  if (state === 'closed') {
    db.viewerPresence = db.viewerPresence.filter((presence) => presence.clientKey !== clientKey)
    return
  }

  const now = new Date().toISOString()
  const current = db.viewerPresence.find((presence) => presence.clientKey === clientKey)
  const nextPresence = {
    id: current?.id ?? randomUUID(),
    sessionId: session.id,
    userId: session.userId,
    clientKey,
    ipAddress: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    createdAt: current?.createdAt ?? now,
    lastSeenAt: now,
  }

  db.viewerPresence = [
    ...db.viewerPresence.filter((presence) => presence.clientKey !== clientKey),
    nextPresence,
  ]
}

function dedupeActiveSessions(sessions) {
  const sessionsByClient = new Map()
  for (const session of sessions) {
    const key = session.clientKey || `${session.userId}|${session.ipAddress ?? ''}|${session.userAgent ?? ''}`
    const current = sessionsByClient.get(key)
    if (!current || Date.parse(session.lastSeenAt ?? session.createdAt) > Date.parse(current.lastSeenAt ?? current.createdAt)) {
      sessionsByClient.set(key, session)
    }
  }

  return [...sessionsByClient.values()]
}

function parseBrowserLabel(userAgent) {
  if (!userAgent) return '-'
  if (userAgent.includes('Edg/')) return `Microsoft Edge ${readUserAgentVersion(userAgent, 'Edg/')}`
  if (userAgent.includes('Chrome/')) return `Chrome ${readUserAgentVersion(userAgent, 'Chrome/')}`
  if (userAgent.includes('Firefox/')) return `Firefox ${readUserAgentVersion(userAgent, 'Firefox/')}`
  if (userAgent.includes('Safari/') && userAgent.includes('Version/')) return `Safari ${readUserAgentVersion(userAgent, 'Version/')}`
  return userAgent
}

function readUserAgentVersion(userAgent, marker) {
  const value = userAgent.split(marker)[1]?.split(/[ .]/)[0]
  return value ? value : ''
}

function getRequestIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim()
}

function getRequestUserAgent(req) {
  return String(req.headers['user-agent'] ?? '')
}

function getSessionClientKey(userId, req) {
  return createHash('sha256')
    .update(`${userId}|${getRequestIp(req)}|${getRequestUserAgent(req)}`)
    .digest('base64url')
}

function getRequestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http')
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim()
  return `${proto}://${host}`
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function redirect(res, location) {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}
