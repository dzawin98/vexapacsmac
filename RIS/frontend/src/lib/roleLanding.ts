export interface RoleLandingPageOption {
  path: string;
  label: string;
  permission: string;
}

export const ROLE_LANDING_PAGE_OPTIONS: RoleLandingPageOption[] = [
  { path: "/dashboard", label: "Dashboard", permission: "view_dashboard" },
  { path: "/worklist", label: "Worklist", permission: "view_worklist" },
  { path: "/distribution", label: "Distribution", permission: "view_quality_control" },
  { path: "/reporting", label: "Reporting", permission: "view_radiologist" },
  { path: "/mwl/register", label: "MWL Register", permission: "view_mwl_register" },
  { path: "/mwl/order", label: "MWL Order", permission: "view_mwl_order" },
  { path: "/mwl/technologist", label: "Technologist", permission: "view_mwl_technologist" },
  { path: "/mwl/status", label: "MWL Status", permission: "view_mwl_status" },
  { path: "/mwl/management-study", label: "Management Study", permission: "view_study_management" },
  { path: "/mwl/doctor-management", label: "Doctor Management", permission: "view_doctor_management" },
  { path: "/mwl/modality-management", label: "Modality Management", permission: "view_modality_management" },
  { path: "/dose/monitor", label: "Dose Monitor", permission: "view_dose_monitor" },
  { path: "/dose/report", label: "Dose Report", permission: "view_dose_report" },
  { path: "/dose/idrl", label: "TPDI / IDRL", permission: "view_dose_idrl" },
  { path: "/report", label: "Management Report", permission: "view_management_report" },
  { path: "/manager", label: "DICOM Manager", permission: "view_dicom_manager" },
  { path: "/settings", label: "Settings", permission: "view_settings" },
  { path: "/backup-restore", label: "Backup & Restore", permission: "view_backup_restore" },
  { path: "/users", label: "User Management", permission: "view_users" },
];

const DEFAULT_ROLE_LANDING_PAGES: Record<string, string> = {
  administrator: "/dashboard",
  technologist: "/mwl/technologist",
  medical_physics: "/dose/monitor",
  radiologist: "/reporting",
  clinician: "/worklist",
};

export const resolveRoleLandingPage = (
  configuredLandingPage: string | null | undefined,
  permissions: Iterable<string>,
  role?: string | null
): string => {
  const allowedPermissions = new Set(permissions);
  const isAllowed = (path: string | null | undefined) => {
    if (!path) return false;
    const option = ROLE_LANDING_PAGE_OPTIONS.find(item => item.path === path);
    return Boolean(option && allowedPermissions.has(option.permission));
  };
  const configured = String(configuredLandingPage || "").trim();
  if (isAllowed(configured)) return configured;
  const normalizedRole = String(role || "").trim().toLowerCase().replace(/\s+/g, "_");
  const roleDefault = DEFAULT_ROLE_LANDING_PAGES[normalizedRole];
  if (isAllowed(roleDefault)) return roleDefault;
  return ROLE_LANDING_PAGE_OPTIONS.find(item => allowedPermissions.has(item.permission))?.path || "/dashboard";
};

export const resolvePostLoginPath = (
  requestedPath: unknown,
  configuredLandingPage: string | null | undefined,
  permissions?: Iterable<string>,
  role?: string | null
): string => {
  if (typeof requestedPath === "string") {
    const requested = requestedPath.trim();
    if (requested.startsWith("/") && !requested.startsWith("//") && requested !== "/" && requested !== "/login") {
      return requested;
    }
  }
  if (permissions) return resolveRoleLandingPage(configuredLandingPage, permissions, role);
  const configured = String(configuredLandingPage || "").trim();
  return ROLE_LANDING_PAGE_OPTIONS.some(item => item.path === configured) ? configured : "/dashboard";
};
