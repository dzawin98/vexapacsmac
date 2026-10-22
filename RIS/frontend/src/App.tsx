import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ThemeProvider, useTheme } from "next-themes";
import { Suspense, lazy, useEffect } from "react";
import AppLayout from "./components/AppLayout";
import { resolvePostLoginPath, resolveRoleLandingPage } from "@/lib/roleLanding";

const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Worklist = lazy(() => import("./pages/Worklist"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const DicomManager = lazy(() => import("./pages/DicomManager"));
const AuditLogPage = lazy(() => import("./pages/AuditLogPage"));
const BackupRestorePage = lazy(() => import("./pages/BackupRestorePage"));
const AssetManagementPage = lazy(() => import("./pages/AssetManagementPage"));
const UserManagement = lazy(() => import("./pages/UserManagement"));
const ManagementReport = lazy(() => import("./pages/ManagementReport"));
const RadiologistWorklist = lazy(() => import("./pages/RadiologistWorklist"));
const RadiologistReport = lazy(() => import("./pages/RadiologistReport"));
const QualityControl = lazy(() => import("./pages/QualityControl"));
const NotFound = lazy(() => import("./pages/NotFound"));
const PublicStudy = lazy(() => import("./pages/PublicStudy"));
const ViewerTokenRedirect = lazy(() => import("./pages/ViewerTokenRedirect"));
const PatientRegister = lazy(() => import("./pages/mwl/PatientRegister"));
const OrderPage = lazy(() => import("./pages/mwl/OrderPage"));
const TechnologistPage = lazy(() => import("./pages/mwl/TechnologistPage"));
const MwlStatusPage = lazy(() => import("./pages/mwl/MwlStatusPage"));
const ManagementStudyPage = lazy(() => import("./pages/mwl/ManagementStudyPage"));
const DoctorManagementPage = lazy(() => import("./pages/mwl/DoctorManagementPage"));
const ModalityManagementPage = lazy(() => import("./pages/mwl/ModalityManagementPage"));
const DoseMonitorPage = lazy(() => import("./pages/dose/DoseMonitorPage"));
const DoseReportPage = lazy(() => import("./pages/dose/DoseReportPage"));
const AverageStudyIdrlPage = lazy(() => import("./pages/dose/AverageStudyIdrlPage"));
const IdrlPage = lazy(() => import("./pages/dose/IdrlPage"));

const queryClient = new QueryClient();

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const from = `${location.pathname}${location.search}${location.hash}`;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from }} />;
  return <>{children}</>;
};

const PermissionRoute = ({
  children,
  allow,
}: {
  children: React.ReactNode;
  allow: string[];
}) => {
  const { hasPermission, permissions, user } = useAuth();
  if (!allow.some(permission => hasPermission(permission))) {
    return (
      <Navigate
        to={resolveRoleLandingPage(user?.defaultLandingPage, permissions, user?.role)}
        replace
      />
    );
  }
  return <>{children}</>;
};

const AuthRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, permissions, user } = useAuth();
  const location = useLocation();
  if (isAuthenticated) {
    return (
      <Navigate
        to={resolvePostLoginPath(
          location.state?.from,
          user?.defaultLandingPage,
          permissions,
          user?.role
        )}
        replace
      />
    );
  }
  return <>{children}</>;
};

const RoleLandingRedirect = () => {
  const { permissions, user } = useAuth();
  return (
    <Navigate
      to={resolveRoleLandingPage(user?.defaultLandingPage, permissions, user?.role)}
      replace
    />
  );
};

const LegacyReportingRedirect = () => {
  const { studyInstanceUid } = useParams();
  const target = studyInstanceUid
    ? `/reporting/report/${encodeURIComponent(studyInstanceUid)}`
    : "/reporting";
  return <Navigate to={target} replace />;
};

const ThemeSync = () => {
  const { user } = useAuth();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (!user?.theme) return;
    setTheme(user.theme);
  }, [setTheme, user?.theme, user?.username]);

  return null;
};

const RouteLoader = () => (
  <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
    Loading...
  </div>
);

const AppRoutes = () => (
  <Suspense fallback={<RouteLoader />}>
    <Routes>
      <Route path="/login" element={<AuthRoute><Login /></AuthRoute>} />
      <Route path="/public/study/:token" element={<PublicStudy />} />
      <Route path="/viewer/token/:token" element={<ViewerTokenRedirect />} />
      <Route path="/viewer/token/:token/:linkKey" element={<ViewerTokenRedirect />} />
      <Route
        path="/manager"
        element={
          <ProtectedRoute>
            <PermissionRoute allow={["view_dicom_manager"]}>
              <DicomManager />
            </PermissionRoute>
          </ProtectedRoute>
        }
      />
      <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<RoleLandingRedirect />} />
        <Route
          path="dashboard"
          element={
            <PermissionRoute allow={["view_dashboard"]}>
              <Dashboard />
            </PermissionRoute>
          }
        />
        <Route
          path="worklist"
          element={
            <PermissionRoute allow={["view_worklist"]}>
              <Worklist
                enableRadiologistAssignment
                showRadiologistAction={false}
                initialDateFilterMode="today"
                enableInlinePreview
              />
            </PermissionRoute>
          }
        />
        <Route
          path="distribution"
          element={
            <PermissionRoute allow={["view_quality_control"]}>
              <QualityControl />
            </PermissionRoute>
          }
        />
        <Route
          path="reporting"
          element={
            <PermissionRoute allow={["view_radiologist"]}>
              <RadiologistWorklist />
            </PermissionRoute>
          }
        />
        <Route
          path="settings"
          element={
            <PermissionRoute allow={["view_settings"]}>
              <SettingsPage />
            </PermissionRoute>
          }
        />
        <Route
          path="audit-logs"
          element={
            <PermissionRoute allow={["view_settings"]}>
              <AuditLogPage />
            </PermissionRoute>
          }
        />
        <Route
          path="backup-restore"
          element={
            <PermissionRoute allow={["view_backup_restore"]}>
              <BackupRestorePage />
            </PermissionRoute>
          }
        />
        <Route
          path="asetmanage"
          element={
            <PermissionRoute allow={["view_management_report", "view_settings"]}>
              <AssetManagementPage />
            </PermissionRoute>
          }
        />
        <Route
          path="users"
          element={
            <PermissionRoute allow={["view_users"]}>
              <UserManagement />
            </PermissionRoute>
          }
        />
        <Route
          path="report"
          element={
            <PermissionRoute allow={["view_management_report"]}>
              <ManagementReport />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/register"
          element={
            <PermissionRoute allow={["view_mwl_register"]}>
              <PatientRegister />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/order"
          element={
            <PermissionRoute allow={["view_mwl_order"]}>
              <OrderPage />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/management-study"
          element={
            <PermissionRoute allow={["view_study_management"]}>
              <ManagementStudyPage />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/doctor-management"
          element={
            <PermissionRoute allow={["view_doctor_management"]}>
              <DoctorManagementPage />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/modality-management"
          element={
            <PermissionRoute allow={["view_modality_management"]}>
              <ModalityManagementPage />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/technologist"
          element={
            <PermissionRoute allow={["view_mwl_technologist"]}>
              <TechnologistPage />
            </PermissionRoute>
          }
        />
        <Route
          path="mwl/status"
          element={
            <PermissionRoute allow={["view_mwl_status"]}>
              <MwlStatusPage />
            </PermissionRoute>
          }
        />
        <Route
          path="dose/monitor"
          element={
            <PermissionRoute allow={["view_dose_monitor"]}>
              <DoseMonitorPage />
            </PermissionRoute>
          }
        />
        <Route
          path="dose/report"
          element={
            <PermissionRoute allow={["view_dose_report"]}>
              <DoseReportPage />
            </PermissionRoute>
          }
        />
        <Route
          path="dose/avgstudyidrl"
          element={
            <PermissionRoute allow={["view_dose_report"]}>
              <AverageStudyIdrlPage />
            </PermissionRoute>
          }
        />
        <Route
          path="dose/idrl"
          element={
            <PermissionRoute allow={["view_dose_idrl"]}>
              <IdrlPage />
            </PermissionRoute>
          }
        />
      </Route>
      <Route
        path="/reporting/report/:studyInstanceUid"
        element={
          <ProtectedRoute>
            <PermissionRoute allow={["view_radiologist"]}>
              <RadiologistReport />
            </PermissionRoute>
          </ProtectedRoute>
        }
      />
      <Route path="/quality-control" element={<Navigate to="/distribution" replace />} />
      <Route path="/radiologist" element={<Navigate to="/reporting" replace />} />
      <Route path="/radiologist/report/:studyInstanceUid" element={<LegacyReportingRedirect />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </Suspense>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      <AuthProvider>
        <ThemeSync />
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter
            future={{
              v7_startTransition: true,
              v7_relativeSplatPath: true,
            }}
          >
            <AppRoutes />
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
