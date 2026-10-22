import { LayoutDashboard, Radiation, Settings, Users, LogOut, ChevronLeft, ChevronRight, ChevronDown, Moon, Sun, ClipboardCheck, UserRoundPlus, FilePlus2, Stethoscope, ActivitySquare, BookMarked, UserRoundCog, MonitorCog, FileClock, List, Shuffle, FolderPen, FileBarChart2, ShieldCheck, SquareActivity, ChevronsLeftRightEllipsis, Wrench, DatabaseBackup } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { usersService } from "@/lib/dicomService";
import { useTheme } from "next-themes";
import { useLocation } from "react-router-dom";
import { resolveBackendUrl } from "@/lib/backendUrl";

const navItems = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, permission: "view_dashboard" },
  { title: "Worklist", url: "/worklist", icon: List, permission: "view_worklist" },
];

const orderChildren = [
  { title: "Register", url: "/mwl/register", icon: UserRoundPlus, permission: "view_mwl_register" },
  { title: "Order", url: "/mwl/order", icon: FilePlus2, permission: "view_mwl_order" },
  { title: "Status", url: "/mwl/status", icon: ActivitySquare, permission: "view_mwl_status" },
];

const medicalPhysicChildren = [
  { title: "Monitor", url: "/dose/monitor", icon: SquareActivity, permission: "view_dose_monitor" },
  { title: "Report", url: "/dose/report", icon: FileBarChart2, permission: "view_dose_report" },
  { title: "Average Study IDRL", url: "/dose/avgstudyidrl", icon: FileBarChart2, permission: "view_dose_report" },
  { title: "IDRL", url: "/dose/idrl", icon: ChevronsLeftRightEllipsis, permission: "view_dose_idrl" },
  { title: "Asset", url: "/asetmanage", icon: Wrench, permission: "view_management_report" },
];

const databaseChildren = [
  { title: "Study", url: "/mwl/management-study", icon: BookMarked, permission: "view_study_management" },
  { title: "Modality", url: "/mwl/modality-management", icon: MonitorCog, permission: "view_modality_management" },
  { title: "Doctor", url: "/mwl/doctor-management", icon: UserRoundCog, permission: "view_doctor_management" },
  { title: "Report & Performance", url: "/report", icon: FileBarChart2, permission: "view_management_report" },
];

const systemAccountChildren = [
  { title: "User", url: "/users", icon: Users, permission: "view_users" },
];

const systemManagementChildren = [
  { title: "Logs", url: "/audit-logs", icon: FileClock, permission: "view_settings" },
  { title: "Backup & Restore", url: "/backup-restore", icon: DatabaseBackup, permission: "view_backup_restore" },
];

const navItemsAfterOrder = [
  { title: "Technologist", url: "/mwl/technologist", icon: Radiation, permission: "view_mwl_technologist" },
  { title: "Reporting", url: "/reporting", icon: Stethoscope, permission: "view_radiologist" },
  { title: "Distribution", url: "/distribution", icon: ClipboardCheck, permission: "view_quality_control" },
];

const DEFAULT_APP_VERSION = "Version 1.26.1";

type AppSidebarProps = {
  variant?: "desktop" | "mobile";
  onNavigate?: () => void;
};

const AppSidebar = ({ variant = "desktop", onNavigate }: AppSidebarProps) => {
  const { user, logout, hasPermission, setUserTheme } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const { toast } = useToast();
  const [changeOpen, setChangeOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<"order" | "medicalPhysic" | "database" | "systemAccount" | "systemManagement" | null>(null);
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION);
  const { resolvedTheme, setTheme } = useTheme();
  const location = useLocation();
  const isMobileVariant = variant === "mobile";
  const effectiveCollapsed = isMobileVariant ? false : collapsed;
  const currentPath = location.pathname;

  useEffect(() => {
    let mounted = true;
    fetch(`${resolveBackendUrl()}/public/facility`)
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (!mounted) return;
        setAppVersion(payload?.appVersion?.trim() || DEFAULT_APP_VERSION);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const resetPasswordForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleChangePassword = async () => {
    if (!user) return;
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast({
        title: "Validation failed",
        description: "All password fields are required.",
        variant: "destructive",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({
        title: "Validation failed",
        description: "New password and confirmation do not match.",
        variant: "destructive",
      });
      return;
    }
    setChanging(true);
    try {
      await usersService.changePassword({
        username: user.username,
        currentPassword,
        newPassword,
      });
      toast({
        title: "Password updated",
        description: "Your password has been updated.",
      });
      setChangeOpen(false);
      resetPasswordForm();
    } catch (error) {
      toast({
        title: "Password update failed",
        description: error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setChanging(false);
    }
  };

  const handleToggleTheme = async () => {
    const activeTheme = resolvedTheme === "dark" ? "dark" : "light";
    const nextTheme = activeTheme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    if (!user) return;
    try {
      setUserTheme(nextTheme);
      await usersService.updateUserTheme({ username: user.username, theme: nextTheme });
    } catch (error) {
      const fallbackTheme = user.theme === "dark" ? "dark" : "light";
      setTheme(fallbackTheme);
      setUserTheme(fallbackTheme);
      toast({
        title: "Theme update failed",
        description: error instanceof Error ? error.message : "Unable to save theme preference.",
        variant: "destructive",
      });
    }
  };

  const handleLeafMenuClick = () => {
    setExpandedGroup(null);
    onNavigate?.();
  };

  const handleChildMenuClick = () => {
    onNavigate?.();
  };

  const visibleOrderChildren = orderChildren.filter(item => hasPermission(item.permission));
  const visibleMedicalPhysicChildren = medicalPhysicChildren.filter(item => hasPermission(item.permission));
  const visibleDatabaseChildren = databaseChildren.filter(item => hasPermission(item.permission));
  const visibleSystemAccountChildren = systemAccountChildren.filter(item => hasPermission(item.permission));
  const visibleSystemManagementChildren = systemManagementChildren.filter(item => hasPermission(item.permission));
  const isOrderActive = orderChildren.some(item => currentPath.startsWith(item.url));
  const isMedicalPhysicActive = medicalPhysicChildren.some(item => currentPath.startsWith(item.url));
  const isDatabaseActive = databaseChildren.some(item => currentPath.startsWith(item.url));
  const isSystemAccountActive = systemAccountChildren.some(item => currentPath.startsWith(item.url));
  const isSystemManagementActive = systemManagementChildren.some(item => currentPath.startsWith(item.url));

  return (
    <aside
      className={cn(
        "app-sidebar relative z-30 flex flex-col bg-card border-r border-border transition-all duration-300 shrink-0",
        isMobileVariant ? "h-full w-full" : "h-screen sticky top-0 hidden md:flex",
        !isMobileVariant && (effectiveCollapsed ? "w-[68px]" : "w-[240px]")
      )}
    >
      <div className="flex items-center justify-between px-4 h-16 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="VEXA-RIS logo" className="w-9 h-9 object-contain" />
          </div>
          {!effectiveCollapsed && <span className="text-base font-bold text-foreground whitespace-nowrap">VEXA-RIS</span>}
        </div>
        {!isMobileVariant && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(c => !c)}
            className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </Button>
        )}
      </div>

      <Dialog
        open={changeOpen}
        onOpenChange={open => {
          setChangeOpen(open);
          if (!open) resetPasswordForm();
        }}
      >
        {!effectiveCollapsed && user ? (
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center gap-3">
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                >
                  <Users className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{user.fullName}</p>
                <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 border-b border-border flex items-center justify-center">
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                disabled={!user}
              >
                <Users className="w-4 h-4" />
              </Button>
            </DialogTrigger>
          </div>
        )}
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Current Password</Label>
              <Input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                className="rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label>New Password</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label>Confirm New Password</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="rounded-xl"
              />
            </div>
            <Button
              disabled={changing}
              className="w-full rounded-xl gradient-medical border-0"
              onClick={handleChangePassword}
            >
              {changing ? "Updating..." : "Update Password"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {navItems
          .filter(item => (item.permission ? hasPermission(item.permission) : true))
          .map(item => (
            <NavLink
              key={item.url}
              to={item.url}
              end={item.url === "/dashboard"}
              onClick={handleLeafMenuClick}
              className="app-sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors"
              activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <item.icon className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
            </NavLink>
          ))}

        {visibleOrderChildren.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setExpandedGroup(prev => (prev === "order" ? null : "order"))}
              className={cn(
                "app-sidebar-group-trigger",
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary/60 transition-colors",
                (expandedGroup === "order" || isOrderActive) && "bg-secondary/40"
              )}
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <Shuffle className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate flex-1 text-left">Order</span>}
              {!effectiveCollapsed && (
                <ChevronDown
                  className={cn(
                    "w-4 h-4 transition-transform",
                    expandedGroup === "order" ? "rotate-180" : "rotate-0"
                  )}
                />
              )}
            </button>
            <div
              className={cn(
                "overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out",
                expandedGroup === "order" ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0 mt-0 pointer-events-none"
              )}
            >
              {visibleOrderChildren.map(item => (
                <NavLink
                  key={item.url}
                  to={item.url}
                  onClick={handleChildMenuClick}
                  className={cn(
                    "app-sidebar-link",
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors",
                    !effectiveCollapsed && "ml-4"
                  )}
                  activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
                >
                  <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4" />
                  </div>
                  {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        )}

        {navItemsAfterOrder
          .filter(item => (item.permission ? hasPermission(item.permission) : true))
          .map(item => (
            <NavLink
              key={item.url}
              to={item.url}
              onClick={handleLeafMenuClick}
              className="app-sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors"
              activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <item.icon className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
            </NavLink>
          ))}

        {visibleMedicalPhysicChildren.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setExpandedGroup(prev => (prev === "medicalPhysic" ? null : "medicalPhysic"))}
              className={cn(
                "app-sidebar-group-trigger",
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary/60 transition-colors",
                (expandedGroup === "medicalPhysic" || isMedicalPhysicActive) && "bg-secondary/40"
              )}
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <ShieldCheck className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate flex-1 text-left">Medical Physic</span>}
              {!effectiveCollapsed && <ChevronDown className={cn("w-4 h-4 transition-transform", expandedGroup === "medicalPhysic" ? "rotate-180" : "rotate-0")} />}
            </button>
            <div className={cn("overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out", expandedGroup === "medicalPhysic" ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0 mt-0 pointer-events-none")}>
              {visibleMedicalPhysicChildren.map(item => (
                <NavLink
                  key={item.url}
                  to={item.url}
                  onClick={handleChildMenuClick}
                  className={cn("app-sidebar-link", "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors", !effectiveCollapsed && "ml-4")}
                  activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
                >
                  <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4" />
                  </div>
                  {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        )}

        {hasPermission("view_settings") && (
          <NavLink
            to="/settings"
            onClick={handleLeafMenuClick}
            className="app-sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors"
            activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
          >
            <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
              <Settings className="w-4 h-4" />
            </div>
            {!effectiveCollapsed && <span className="truncate">Settings</span>}
          </NavLink>
        )}

        {visibleDatabaseChildren.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setExpandedGroup(prev => (prev === "database" ? null : "database"))}
              className={cn(
                "app-sidebar-group-trigger",
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary/60 transition-colors",
                (expandedGroup === "database" || isDatabaseActive) && "bg-secondary/40"
              )}
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <FolderPen className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate flex-1 text-left">Database</span>}
              {!effectiveCollapsed && (
                <ChevronDown
                  className={cn(
                    "w-4 h-4 transition-transform",
                    expandedGroup === "database" ? "rotate-180" : "rotate-0"
                  )}
                />
              )}
            </button>
            <div
              className={cn(
                "overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out",
                expandedGroup === "database" ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0 mt-0 pointer-events-none"
              )}
            >
              {visibleDatabaseChildren.map(item => (
                <NavLink
                  key={item.url}
                  to={item.url}
                  onClick={handleChildMenuClick}
                  className={cn(
                    "app-sidebar-link",
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors",
                    !effectiveCollapsed && "ml-4"
                  )}
                  activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
                >
                  <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4" />
                  </div>
                  {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        )}

        {visibleSystemAccountChildren.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setExpandedGroup(prev => (prev === "systemAccount" ? null : "systemAccount"))}
              className={cn(
                "app-sidebar-group-trigger",
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary/60 transition-colors",
                (expandedGroup === "systemAccount" || isSystemAccountActive) && "bg-secondary/40"
              )}
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate flex-1 text-left">System Account</span>}
              {!effectiveCollapsed && (
                <ChevronDown
                  className={cn(
                    "w-4 h-4 transition-transform",
                    expandedGroup === "systemAccount" ? "rotate-180" : "rotate-0"
                  )}
                />
              )}
            </button>
            <div
              className={cn(
                "overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out",
                expandedGroup === "systemAccount" ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0 mt-0 pointer-events-none"
              )}
            >
              {visibleSystemAccountChildren.map(item => (
                <NavLink
                  key={item.url}
                  to={item.url}
                  onClick={handleChildMenuClick}
                  className={cn(
                    "app-sidebar-link",
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors",
                    !effectiveCollapsed && "ml-4"
                  )}
                  activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
                >
                  <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4" />
                  </div>
                  {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        )}

        {visibleSystemManagementChildren.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setExpandedGroup(prev => (prev === "systemManagement" ? null : "systemManagement"))}
              className={cn(
                "app-sidebar-group-trigger",
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary/60 transition-colors",
                (expandedGroup === "systemManagement" || isSystemManagementActive) && "bg-secondary/40"
              )}
            >
              <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                <FileClock className="w-4 h-4" />
              </div>
              {!effectiveCollapsed && <span className="truncate flex-1 text-left">System Management</span>}
              {!effectiveCollapsed && (
                <ChevronDown
                  className={cn(
                    "w-4 h-4 transition-transform",
                    expandedGroup === "systemManagement" ? "rotate-180" : "rotate-0"
                  )}
                />
              )}
            </button>
            <div
              className={cn(
                "overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out",
                expandedGroup === "systemManagement" ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0 mt-0 pointer-events-none"
              )}
            >
              {visibleSystemManagementChildren.map(item => (
                <NavLink
                  key={item.url}
                  to={item.url}
                  onClick={handleChildMenuClick}
                  className={cn(
                    "app-sidebar-link",
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-black dark:text-white hover:bg-secondary hover:text-black dark:hover:text-white transition-colors",
                    !effectiveCollapsed && "ml-4"
                  )}
                  activeClassName="app-sidebar-link-active bg-primary/15 text-black dark:text-white hover:bg-primary/20"
                >
                  <div className="w-8 h-8 rounded-sm bg-muted flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4" />
                  </div>
                  {!effectiveCollapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className={cn("px-3 pb-2 text-[11px] font-semibold text-muted-foreground/75", effectiveCollapsed ? "text-center" : "text-left")}>
        {effectiveCollapsed ? appVersion.replace(/^Version\s*/i, "v") : appVersion}
      </div>

      <div className="border-t border-border p-3 shrink-0 space-y-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleTheme}
          className={cn(
            "w-full rounded-xl text-muted-foreground hover:bg-transparent hover:text-muted-foreground",
            effectiveCollapsed ? "px-0 justify-center" : "justify-start"
          )}
        >
          {resolvedTheme === "dark" ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
          {!effectiveCollapsed && <span className="ml-2">{resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={logout}
          className={cn(
            "w-full rounded-xl text-muted-foreground hover:bg-transparent hover:text-muted-foreground",
            effectiveCollapsed ? "px-0 justify-center" : "justify-start"
          )}
        >
          <LogOut className="w-4 h-4 shrink-0 text-destructive" />
          {!effectiveCollapsed && <span className="ml-2">Log out</span>}
        </Button>
      </div>
    </aside>
  );
};

export default AppSidebar;
