import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserPlus, Trash2, Loader2, Edit2, Plus, Home } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usersService, roleService, mwlService, User, RolePermissions, MwlDoctor } from "@/lib/dicomService";
import LoadingScreen from "@/components/LoadingScreen";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";
import { ROLE_LANDING_PAGE_OPTIONS, resolveRoleLandingPage } from "@/lib/roleLanding";

const permissionCatalog = [
  { key: "view_dashboard", label: "Dashboard", group: "Pages" },
  { key: "view_management_report", label: "Management Report", group: "Pages" },
  { key: "view_worklist", label: "Worklist", group: "Pages" },
  { key: "view_quality_control", label: "Distribution", group: "Pages" },
  { key: "view_radiologist", label: "Reporting", group: "Pages" },
  { key: "view_mwl_register", label: "MWL Register", group: "Pages" },
  { key: "view_mwl_order", label: "MWL Order", group: "Pages" },
  { key: "view_study_management", label: "Management Study", group: "Pages" },
  { key: "view_doctor_management", label: "Doctor Management", group: "Pages" },
  { key: "view_modality_management", label: "Modality Management", group: "Pages" },
  { key: "view_mwl_technologist", label: "MWL Technologist", group: "Pages" },
  { key: "view_mwl_status", label: "MWL Status", group: "Pages" },
  { key: "view_dose_monitor", label: "Dose Monitor", group: "Dose" },
  { key: "view_dose_report", label: "Dose Report", group: "Dose" },
  { key: "view_dose_idrl", label: "TPDI / IDRL", group: "Dose" },
  { key: "view_dicom_manager", label: "DICOM Manager", group: "Pages" },
  { key: "view_settings", label: "Settings / System Log", group: "Pages" },
  { key: "view_backup_restore", label: "Backup & Restore", group: "Pages" },
  { key: "view_users", label: "User Management", group: "Pages" },
  { key: "download_study", label: "Download DICOM", group: "Actions" },
  { key: "edit_metadata", label: "Edit Metadata", group: "Actions" },
  { key: "delete_study", label: "Delete Study", group: "Actions" },
  { key: "delete_series", label: "Delete Series", group: "Actions" },
  { key: "delete_instance", label: "Delete Image", group: "Actions" },
  { key: "restore_dicom_manager_operation", label: "Restore DICOM Manager Operation", group: "Actions" },
  { key: "edit_settings", label: "Edit Settings", group: "Actions" },
  { key: "restart_server", label: "Restart Server", group: "Actions" },
  { key: "qc_process", label: "Process QC", group: "Actions" },
  { key: "send_mwl", label: "Send MWL", group: "Actions" },
  { key: "manage_study_management", label: "Manage Study Master", group: "Actions" },
  { key: "manage_doctor_management", label: "Manage Doctor Master", group: "Actions" },
  { key: "manage_modality_management", label: "Manage Modality Master", group: "Actions" },
  { key: "manage_users", label: "Manage Users", group: "Actions" },
  { key: "manage_roles", label: "Manage Roles", group: "Actions" },
  { key: "manage_backup_restore", label: "Manage Backup & Restore", group: "Actions" },
  { key: "report_create", label: "Create Report", group: "Radiologist" },
  { key: "report_edit", label: "Edit Report", group: "Radiologist" },
  { key: "report_finalize", label: "Finalize Report", group: "Radiologist" },
  { key: "report_print", label: "Print Report", group: "Radiologist" },
  { key: "report_export", label: "Export PDF", group: "Radiologist" },
  { key: "change_password", label: "Change Password", group: "Actions" },
] as const;

const doctorGroupOptions = ["CLINICIAN", "RADIOLOGIST", "TECHNOLOGIST", "FISMED"] as const;

type EditableUser = User & { password?: string; passwordpacs?: string; doctorId?: string };

const defaultRoles = ["administrator", "technologist", "medical_physics", "radiologist", "clinician"] as const;
const normalizeRoleName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "_");
const roleLabel = (role: string) => role === "medical_physics" ? "MEDICAL PHYSICS" : role.replace(/_/g, " ").toUpperCase();
const doctorGroupLabel = (group?: string | null) => group === "FISMED" ? "MEDICAL PHYSICS" : group || "";

const UserManagement = () => {
  const { hasPermission } = useAuth();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [users, setUsers] = useState<User[]>([]);
  const [doctorOptions, setDoctorOptions] = useState<MwlDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newUser, setNewUser] = useState({
    username: "",
    name: "",
    phoneNumber: "",
    usernamepacs: "",
    passwordpacs: "",
    password: "",
    role: "clinician",
    doctorId: "",
  });
  const [editUser, setEditUser] = useState<EditableUser | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [roles, setRoles] = useState<RolePermissions[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [selectedRole, setSelectedRole] = useState<string>("administrator");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [selectedDoctorGroup, setSelectedDoctorGroup] = useState<string>("");
  const [selectedDefaultLandingPage, setSelectedDefaultLandingPage] = useState<string>("");
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [creatingRole, setCreatingRole] = useState(false);
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePermissions, setNewRolePermissions] = useState<Set<string>>(new Set());
  const [newRoleDoctorGroup, setNewRoleDoctorGroup] = useState<string>("");
  const [newRoleDefaultLandingPage, setNewRoleDefaultLandingPage] = useState<string>("");
  const { toast } = useToast();

  const loadUsers = useCallback(async () => {
    try {
      const data = await usersService.fetchUsers();
      setUsers(data);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load users", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const loadDoctors = useCallback(async () => {
    try {
      const doctors = await mwlService.fetchDoctors({ role: "ALL" });
      setDoctorOptions(doctors);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load doctor master", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  const loadRoles = useCallback(async () => {
    try {
      const data = await roleService.fetchRoles();
      setRoles(data);
      if (data.length) {
        const firstRole = data[0].role;
        setSelectedRole(prev => (prev ? prev : firstRole));
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to load role permissions", variant: "destructive" });
    } finally {
      setRolesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (hasPermission("manage_roles")) {
      loadRoles();
    }
  }, [hasPermission, loadRoles]);

  useEffect(() => {
    if (!roles.length) return;
    const match = roles.find(role => role.role === selectedRole);
    const permissions = match?.permissions ?? [];
    setSelectedPermissions(new Set(permissions));
    setSelectedDoctorGroup(match?.doctor_group || "");
    setSelectedDefaultLandingPage(
      resolveRoleLandingPage(match?.default_landing_page, permissions, selectedRole)
    );
  }, [roles, selectedRole]);

  useEffect(() => {
    setSelectedDefaultLandingPage(current =>
      resolveRoleLandingPage(current, selectedPermissions, selectedRole)
    );
  }, [selectedPermissions, selectedRole]);

  useEffect(() => {
    setNewRoleDefaultLandingPage(current =>
      resolveRoleLandingPage(current, newRolePermissions, normalizeRoleName(newRoleName))
    );
  }, [newRoleName, newRolePermissions]);

  const handleAdd = async () => {
    if (!newUser.username.trim() || !newUser.password.trim()) {
      toast({ title: "Validation Error", description: "Username and password are required", variant: "destructive" });
      return;
    }
    const addDoctorGroup = roleDoctorGroupMap.get(newUser.role);
    if (addDoctorGroup && !newUser.doctorId) {
      toast({ title: "Validation Error", description: `${doctorGroupLabel(addDoctorGroup)} link is required`, variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      await usersService.createUser({
        username: newUser.username.trim(),
        name: newUser.name.trim() || newUser.username.trim(),
        phoneNumber: newUser.phoneNumber.trim() || null,
        usernamepacs: newUser.usernamepacs.trim() || null,
        passwordpacs: newUser.passwordpacs.trim() || null,
        password: newUser.password.trim(),
        role: newUser.role,
        doctorId: addDoctorGroup && newUser.doctorId ? Number(newUser.doctorId) : null,
      });
      await Promise.all([loadUsers(), loadDoctors()]);
      setNewUser({
        username: "",
        name: "",
        phoneNumber: "",
        usernamepacs: "",
        passwordpacs: "",
        password: "",
        role: "clinician",
        doctorId: "",
      });
      setAddOpen(false);
      toast({ title: "User added", description: `${newUser.username} has been created` });
    } catch (error) {
      toast({ title: "Error", description: "Failed to create user", variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    const targetUser = users.find(user => user.id === id);
    const reason = await confirmDelete({
      title: "Delete user?",
      description: "This will remove the selected application user.",
      target: targetUser ? `${targetUser.username} - ${targetUser.name}` : `User ID ${id}`,
    });
    if (!reason) return;
    try {
      await usersService.deleteUser(id, { reason });
      await Promise.all([loadUsers(), loadDoctors()]);
      toast({ title: "User deleted" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to delete user", variant: "destructive" });
    }
  };

  const handleUpdate = async () => {
    if (!editUser) return;
    if (!editUser.username.trim()) {
      toast({ title: "Validation Error", description: "Username is required", variant: "destructive" });
      return;
    }
    const editDoctorGroup = roleDoctorGroupMap.get(editUser.role);
    if (editDoctorGroup && !editUser.doctorId) {
      toast({ title: "Validation Error", description: `${doctorGroupLabel(editDoctorGroup)} link is required`, variant: "destructive" });
      return;
    }
    setUpdating(true);
    try {
      const updatePayload = {
        username: editUser.username.trim(),
        name: editUser.name.trim() || editUser.username.trim(),
        phoneNumber: editUser.phone_number?.trim() || null,
        usernamepacs: editUser.usernamepacs?.trim() || null,
        role: editUser.role,
        password: editUser.password?.trim() || undefined,
        doctorId: editDoctorGroup && editUser.doctorId ? Number(editUser.doctorId) : null,
      };
      await usersService.updateUser(
        editUser.id,
        editUser.passwordpacs?.trim()
          ? { ...updatePayload, passwordpacs: editUser.passwordpacs.trim() }
          : updatePayload
      );
      await Promise.all([loadUsers(), loadDoctors()]);
      setEditOpen(false);
      setEditUser(null);
      toast({ title: "User updated", description: "Changes have been saved" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to update user", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  const openEdit = (user: User) => {
    setEditUser({
      ...user,
      password: "",
      passwordpacs: "",
      doctorId: user.doctor_id ? String(user.doctor_id) : "",
    });
    setEditOpen(true);
  };

  if (loading) {
    return <LoadingScreen />;
  }

  const groupedPermissions = permissionCatalog.reduce<Record<string, { key: string; label: string }[]>>(
    (acc, item) => {
      if (!acc[item.group]) acc[item.group] = [];
      acc[item.group].push({ key: item.key, label: item.label });
      return acc;
    },
    {}
  );
  const knownPermissions = new Set<string>(permissionCatalog.map(item => item.key));
  const extraPermissions = Array.from(selectedPermissions).filter(p => !knownPermissions.has(p));
  const roleOrder = new Map<string, number>(defaultRoles.map((role, index) => [role, index]));
  const roleOptions = Array.from(new Set([...defaultRoles, ...roles.map(role => role.role), ...users.map(user => user.role)]))
    .sort((a, b) => (roleOrder.get(a) ?? 99) - (roleOrder.get(b) ?? 99) || a.localeCompare(b));
  const roleDoctorGroupMap = new Map(roleOptions.map(role => [role, roles.find(item => item.role === role)?.doctor_group || null]));
  const getDoctorsForRole = (role: string, currentUserId?: number | null) => {
    const doctorGroup = roleDoctorGroupMap.get(role);
    if (!doctorGroup) return [];
    return doctorOptions.filter(
      doctor => doctor.role === doctorGroup && (!doctor.user_id || doctor.user_id === currentUserId)
    );
  };
  const availableAddDoctors = getDoctorsForRole(newUser.role);
  const availableEditDoctors = getDoctorsForRole(editUser?.role || "", editUser?.id);
  const selectedRoleDoctorGroup = roleDoctorGroupMap.get(selectedRole) || null;
  const availableSelectedLandingPages = ROLE_LANDING_PAGE_OPTIONS.filter(option =>
    selectedPermissions.has(option.permission)
  );
  const availableNewRoleLandingPages = ROLE_LANDING_PAGE_OPTIONS.filter(option =>
    newRolePermissions.has(option.permission)
  );

  const handleTogglePermission = (permission: string, checked: boolean) => {
    setSelectedPermissions(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(permission);
      } else {
        next.delete(permission);
      }
      return next;
    });
  };

  const handleSavePermissions = async () => {
    if (!selectedRole) return;
    const defaultLandingOption = ROLE_LANDING_PAGE_OPTIONS.find(
      option => option.path === selectedDefaultLandingPage
    );
    if (!defaultLandingOption || !selectedPermissions.has(defaultLandingOption.permission)) {
      toast({
        title: "Default page required",
        description: "Select a page permission, then choose the page users should see after login.",
        variant: "destructive",
      });
      return;
    }
    setSavingPermissions(true);
    try {
      await roleService.updateRole(
        selectedRole,
        Array.from(selectedPermissions),
        selectedDoctorGroup || null,
        selectedDefaultLandingPage
      );
      toast({
        title: "Role updated",
        description: `${roleLabel(selectedRole)} will open ${defaultLandingOption.label} after login.`,
      });
      await loadRoles();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update role permissions",
        variant: "destructive",
      });
    } finally {
      setSavingPermissions(false);
    }
  };

  const handleToggleNewRolePermission = (permission: string, checked: boolean) => {
    setNewRolePermissions(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(permission);
      } else {
        next.delete(permission);
      }
      return next;
    });
  };

  const handleCreateRole = async () => {
    const normalizedRole = normalizeRoleName(newRoleName);
    if (!normalizedRole) {
      toast({ title: "Validation Error", description: "Role name is required", variant: "destructive" });
      return;
    }
    if (roleOptions.includes(normalizedRole)) {
      toast({ title: "Validation Error", description: "Role already exists", variant: "destructive" });
      return;
    }
    if (newRolePermissions.size === 0) {
      toast({ title: "Validation Error", description: "Select at least one permission", variant: "destructive" });
      return;
    }
    const defaultLandingOption = ROLE_LANDING_PAGE_OPTIONS.find(
      option => option.path === newRoleDefaultLandingPage
    );
    if (!defaultLandingOption || !newRolePermissions.has(defaultLandingOption.permission)) {
      toast({
        title: "Default page required",
        description: "Select at least one page permission and choose the default login page.",
        variant: "destructive",
      });
      return;
    }
    setCreatingRole(true);
    try {
      await roleService.updateRole(
        normalizedRole,
        Array.from(newRolePermissions),
        newRoleDoctorGroup || null,
        newRoleDefaultLandingPage
      );
      await loadRoles();
      setSelectedRole(normalizedRole);
      setSelectedPermissions(new Set(newRolePermissions));
      setSelectedDoctorGroup(newRoleDoctorGroup || "");
      setNewRoleName("");
      setNewRolePermissions(new Set());
      setNewRoleDoctorGroup("");
      setNewRoleDefaultLandingPage("");
      setCreateRoleOpen(false);
      toast({
        title: "Role created",
        description: `${roleLabel(normalizedRole)} will open ${defaultLandingOption.label} after login.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create role",
        variant: "destructive",
      });
    } finally {
      setCreatingRole(false);
    }
  };

  return (
    <div className="admin-command-page space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">User Management</h1>
          <p className="page-subtitle">Manage users and roles</p>
        </div>
      </div>

      <Tabs defaultValue="users" className="space-y-4">
        <TabsList className="w-full justify-start flex-nowrap overflow-x-auto">
          <TabsTrigger value="users" className="shrink-0">Users</TabsTrigger>
          {hasPermission("manage_roles") && (
            <TabsTrigger value="roles" className="shrink-0">Role Permissions</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="users" className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div />
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button className="rounded-xl">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Add User
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New User</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <div className="space-y-2">
                    <Label>Username</Label>
                    <Input value={newUser.username} onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} placeholder="e.g. dr.smith" />
                  </div>
                  <div className="space-y-2">
                    <Label>Full Name</Label>
                    <Input value={newUser.name} onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Dr. Smith" />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone Number (Optional)</Label>
                    <Input value={newUser.phoneNumber} onChange={e => setNewUser(p => ({ ...p, phoneNumber: e.target.value }))} placeholder="e.g. 628123456789" />
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>PACS Viewer Username</Label>
                      <Input
                        value={newUser.usernamepacs}
                        onChange={e => setNewUser(p => ({ ...p, usernamepacs: e.target.value }))}
                        placeholder="Must match the viewer account"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>PACS Viewer Password</Label>
                      <Input
                        type="password"
                        value={newUser.passwordpacs}
                        onChange={e => setNewUser(p => ({ ...p, passwordpacs: e.target.value }))}
                        placeholder="Must match the viewer account"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <Input type="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select
                      value={newUser.role}
                      onValueChange={value =>
                        setNewUser(p => ({
                          ...p,
                          role: value,
                          doctorId: "",
                        }))
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {roleOptions.map(role => (
                          <SelectItem key={role} value={role}>
                            {roleLabel(role)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {roleDoctorGroupMap.get(newUser.role) && (
                    <div className="space-y-2">
                      <Label>{doctorGroupLabel(roleDoctorGroupMap.get(newUser.role))} Link</Label>
                      <Select value={newUser.doctorId} onValueChange={value => setNewUser(p => ({ ...p, doctorId: value }))}>
                        <SelectTrigger><SelectValue placeholder="Select doctor" /></SelectTrigger>
                        <SelectContent>
                          {availableAddDoctors.map(doctor => (
                            <SelectItem key={doctor.id} value={String(doctor.id)}>
                              {doctor.nama_dokter} ({doctor.kode_dokter})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button disabled={adding} className="w-full" onClick={handleAdd}>
                    {adding && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Create User
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Edit User: {editUser?.username}</DialogTitle>
                </DialogHeader>
                {editUser && (
                  <div className="space-y-4 mt-2">
                    <div className="space-y-2">
                      <Label>Username</Label>
                      <Input value={editUser.username} onChange={e => setEditUser(p => p ? ({ ...p, username: e.target.value }) : null)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Full Name</Label>
                      <Input value={editUser.name} onChange={e => setEditUser(p => p ? ({ ...p, name: e.target.value }) : null)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Phone Number (Optional)</Label>
                      <Input
                        value={editUser.phone_number || ""}
                        onChange={e => setEditUser(p => p ? ({ ...p, phone_number: e.target.value }) : null)}
                        placeholder="e.g. 628123456789"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>PACS Viewer Username</Label>
                        <Input
                          value={editUser.usernamepacs || ""}
                          onChange={e => setEditUser(p => p ? ({ ...p, usernamepacs: e.target.value }) : null)}
                          placeholder="Must match the viewer account"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>PACS Viewer Password</Label>
                        <Input
                          type="password"
                          value={editUser.passwordpacs || ""}
                          onChange={e => setEditUser(p => p ? ({ ...p, passwordpacs: e.target.value }) : null)}
                          placeholder={editUser.has_passwordpacs ? "Saved. Fill to replace." : "Required to launch the viewer"}
                        />
                        {editUser.has_passwordpacs ? (
                          <p className="text-xs text-muted-foreground">The PACS viewer password is saved securely. Fill only to replace it.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>New Password (Leave blank to keep current)</Label>
                      <Input type="password" value={editUser.password || ""} onChange={e => setEditUser(p => p ? ({ ...p, password: e.target.value }) : null)} className="rounded-xl" placeholder="••••••••" />
                    </div>
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select
                        value={editUser.role}
                        onValueChange={value =>
                          setEditUser(p =>
                            p
                              ? {
                                  ...p,
                                  role: value,
                                  doctorId: "",
                                }
                              : null
                          )
                        }
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {roleOptions.map(role => (
                            <SelectItem key={role} value={role}>
                              {roleLabel(role)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {roleDoctorGroupMap.get(editUser.role) && (
                      <div className="space-y-2">
                        <Label>{doctorGroupLabel(roleDoctorGroupMap.get(editUser.role))} Link</Label>
                        <Select
                          value={editUser.doctorId || ""}
                          onValueChange={value => setEditUser(p => (p ? { ...p, doctorId: value } : null))}
                        >
                          <SelectTrigger><SelectValue placeholder="Select doctor" /></SelectTrigger>
                          <SelectContent>
                            {availableEditDoctors.map(doctor => (
                              <SelectItem key={doctor.id} value={String(doctor.id)}>
                                {doctor.nama_dokter} ({doctor.kode_dokter})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <Button disabled={updating} className="w-full" onClick={handleUpdate}>
                      {updating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Save Changes
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="section-title">User List</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Full Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Phone Number</TableHead>
                    <TableHead>PACS User</TableHead>
                    <TableHead>Doctor Link</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8}>No users yet.</TableCell>
                    </TableRow>
                  ) : (
                    users.map(u => (
                      <TableRow key={u.id}>
                        <TableCell>{u.username}</TableCell>
                        <TableCell>{u.name}</TableCell>
                        <TableCell>{roleLabel(u.role)}</TableCell>
                        <TableCell>{u.phone_number || "-"}</TableCell>
                        <TableCell>{u.usernamepacs || "-"}</TableCell>
                        <TableCell>{u.doctor_name ? `${u.doctor_name} (${u.doctor_code || "-"})` : "-"}</TableCell>
                        <TableCell>{new Date(u.created_at).toLocaleDateString()}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => openEdit(u)}>
                              <Edit2 className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="outline" className="h-8 w-8 text-destructive" onClick={() => handleDelete(u.id)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {hasPermission("manage_roles") && (
          <TabsContent value="roles" className="space-y-6">
            <div className="medical-card space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Role Permissions</h2>
                  <p className="text-xs text-muted-foreground">Select allowed pages and actions</p>
                </div>
                <div className="flex min-w-[200px] items-center gap-2">
                  <Select value={selectedRole} onValueChange={setSelectedRole}>
                    <SelectTrigger className="rounded-xl">
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map(role => (
                        <SelectItem key={role} value={role}>
                          {roleLabel(role)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Dialog open={createRoleOpen} onOpenChange={setCreateRoleOpen}>
                    <DialogTrigger asChild>
                      <Button type="button" variant="outline" className="rounded-xl">
                        <Plus className="mr-2 h-4 w-4" />
                        Role
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-3xl">
                      <DialogHeader>
                        <DialogTitle>Create Role</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Role Name</Label>
                          <Input
                            value={newRoleName}
                            onChange={e => setNewRoleName(e.target.value)}
                            placeholder="e.g. supervisor_radiology"
                          />
                          <p className="text-xs text-muted-foreground">
                            Role name will be saved in lowercase and spaces become underscores.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Doctor Group</Label>
                          <Select value={newRoleDoctorGroup || "__none__"} onValueChange={value => setNewRoleDoctorGroup(value === "__none__" ? "" : value)}>
                            <SelectTrigger>
                              <SelectValue placeholder="No doctor group" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">No doctor group</SelectItem>
                              {doctorGroupOptions.map(group => (
                                <SelectItem key={group} value={group}>
                                  {doctorGroupLabel(group)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4">
                          <div className="flex items-center gap-2">
                            <Home className="h-4 w-4 text-primary" />
                            <Label>Default Page After Login</Label>
                          </div>
                          <Select
                            value={
                              availableNewRoleLandingPages.some(
                                option => option.path === newRoleDefaultLandingPage
                              )
                                ? newRoleDefaultLandingPage
                                : ""
                            }
                            onValueChange={setNewRoleDefaultLandingPage}
                            disabled={availableNewRoleLandingPages.length === 0}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select page permissions first" />
                            </SelectTrigger>
                            <SelectContent>
                              {availableNewRoleLandingPages.map(option => (
                                <SelectItem key={option.path} value={option.path}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Only pages enabled in the permission list can be selected.
                          </p>
                        </div>
                        <div className="max-h-[48vh] overflow-y-auto pr-2">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          {Object.entries(groupedPermissions).map(([group, items]) => (
                            <div key={group} className="rounded-xl border border-border p-4">
                              <h3 className="mb-3 text-sm font-semibold text-foreground">{group}</h3>
                              <div className="space-y-2">
                                {items.map(item => (
                                  <label key={item.key} className="flex items-center gap-2 text-sm text-foreground">
                                    <Checkbox
                                      checked={newRolePermissions.has(item.key)}
                                      onCheckedChange={checked => handleToggleNewRolePermission(item.key, Boolean(checked))}
                                    />
                                    <span>{item.label}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                        </div>
                        <div className="flex justify-end">
                          <Button type="button" onClick={handleCreateRole} disabled={creatingRole}>
                            {creatingRole && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Create Role
                          </Button>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
              {rolesLoading ? (
                <div className="text-sm text-muted-foreground">Loading role permissions...</div>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2 rounded-xl border border-border bg-card/60 p-4">
                      <Label>Doctor Group Mapping</Label>
                      <Select value={selectedDoctorGroup || "__none__"} onValueChange={value => setSelectedDoctorGroup(value === "__none__" ? "" : value)}>
                        <SelectTrigger className="rounded-xl">
                          <SelectValue placeholder="No doctor group" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No doctor group</SelectItem>
                          {doctorGroupOptions.map(group => (
                            <SelectItem key={group} value={group}>
                              {doctorGroupLabel(group)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {selectedRoleDoctorGroup
                          ? `Users with this role must be linked to doctor group ${doctorGroupLabel(selectedRoleDoctorGroup)}.`
                          : "This role does not need to be linked to the doctor/staff master."}
                      </p>
                    </div>
                    <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <div className="flex items-center gap-2">
                        <Home className="h-4 w-4 text-primary" />
                        <Label>Default Page After Login</Label>
                      </div>
                      <Select
                        value={
                          availableSelectedLandingPages.some(
                            option => option.path === selectedDefaultLandingPage
                          )
                            ? selectedDefaultLandingPage
                            : ""
                        }
                        onValueChange={setSelectedDefaultLandingPage}
                        disabled={availableSelectedLandingPages.length === 0}
                      >
                        <SelectTrigger className="rounded-xl">
                          <SelectValue placeholder="Select page permissions first" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableSelectedLandingPages.map(option => (
                            <SelectItem key={option.path} value={option.path}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Users with role {roleLabel(selectedRole)} will open this page immediately after login.
                      </p>
                    </div>
                  </div>
                  <div className="max-h-[52vh] overflow-y-auto pr-2">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {Object.entries(groupedPermissions).map(([group, items]) => (
                    <div key={group} className="rounded-xl border border-border p-4">
                      <h3 className="text-sm font-semibold text-foreground mb-3">{group}</h3>
                      <div className="space-y-2">
                        {items.map(item => (
                          <label key={item.key} className="flex items-center gap-2 text-sm text-foreground">
                            <Checkbox
                              checked={selectedPermissions.has(item.key)}
                              onCheckedChange={checked => handleTogglePermission(item.key, Boolean(checked))}
                            />
                            <span>{item.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    ))}
                    {extraPermissions.length > 0 && (
                      <div className="rounded-xl border border-border p-4">
                        <h3 className="text-sm font-semibold text-foreground mb-3">Other</h3>
                        <div className="space-y-2">
                          {extraPermissions.map(permission => (
                            <label key={permission} className="flex items-center gap-2 text-sm text-foreground">
                              <Checkbox
                                checked={selectedPermissions.has(permission)}
                                onCheckedChange={checked => handleTogglePermission(permission, Boolean(checked))}
                              />
                              <span>{permission}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  className="rounded-xl gradient-medical border-0"
                  onClick={handleSavePermissions}
                  disabled={savingPermissions || !selectedRole}
                >
                  {savingPermissions && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save Role Settings
                </Button>
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
      {DeleteReasonDialog}
    </div>
  );
};

export default UserManagement;
