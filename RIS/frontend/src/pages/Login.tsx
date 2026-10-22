import { useEffect, useState, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Lock, User, Activity, AlertCircle, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { resolveBackendUrl } from "@/lib/backendUrl";
import { resolvePostLoginPath } from "@/lib/roleLanding";
import { consumeSessionExpiredReason } from "@/lib/session";

const DEFAULT_APP_VERSION = "Version 1.26.1";

const Login = () => {
  const { login, loginWithGoogle } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { resolvedTheme, setTheme } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [facility, setFacility] = useState({ name: "NEXIA DEMO Hospital", address: "1 Demo Hospital Street" });
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION);
  // Set by lib/session when a stale tab is kicked back to the login screen.
  const [sessionNotice, setSessionNotice] = useState<string>("");

  useEffect(() => {
    const reason = consumeSessionExpiredReason();
    if (reason === "idle") {
      setSessionNotice("Your session ended because there was no activity. Please sign in again.");
    } else if (reason === "rejected") {
      setSessionNotice("Your session is no longer valid on the server. Please sign in again.");
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    fetch(`${resolveBackendUrl()}/public/facility`)
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (!mounted) return;
        setFacility({
          name: payload?.facility?.name?.trim() || "NEXIA DEMO Hospital",
          address: payload?.facility?.address?.trim() || "1 Demo Hospital Street",
        });
        setAppVersion(payload?.appVersion?.trim() || DEFAULT_APP_VERSION);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const googleButtonRef = useRef<HTMLDivElement>(null);

  const handleGoogleResponse = async (response: { credential: string }) => {
    if (!response?.credential) return;
    setLoading(true);
    const result = await loginWithGoogle(response.credential);
    setLoading(false);
    if (result.success) {
      navigate(resolvePostLoginPath(location.state?.from, result.landingPage), { replace: true });
      return;
    }
    toast({
      title: "Google login failed",
      description: "Your Google account could not be authenticated. It may not be registered in this system.",
      variant: "destructive",
    });
  };

  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) return;

    const renderGoogleButton = () => {
      if (!googleButtonRef.current || !window.google?.accounts) return;
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleResponse,
          cancel_on_tap_outside: false,
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          width: "100%",
          text: "signin_with",
          locale: "en",
          shape: "rectangular",
        });
      } catch (e) {
        console.error("Google init error:", e);
      }
    };

    if (window.google?.accounts) {
      renderGoogleButton();
    } else {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client?hl=en";
      script.async = true;
      script.defer = true;
      script.onload = renderGoogleButton;
      document.head.appendChild(script);
    }

    return () => {
      if (googleButtonRef.current) {
        googleButtonRef.current.innerHTML = "";
      }
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username || !password) {
      toast({
        title: "Login failed",
        description: "Username and password are required.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    const result = await login(username, password);
    setLoading(false);
    if (result.success) {
      navigate(resolvePostLoginPath(location.state?.from, result.landingPage), { replace: true });
      return;
    }
    toast({
      title: "Login failed",
      description: "Incorrect username or password.",
      variant: "destructive",
    });
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-background text-foreground">
      <style>
        {`@keyframes drift {
  0% { background-position: 0% 0%, 0% 0%; }
  50% { background-position: 120% 40%, 60% 80%; }
  100% { background-position: 0% 0%, 0% 0%; }
}
@keyframes floaty {
  0% { transform: translateY(0px); }
  50% { transform: translateY(-8px); }
  100% { transform: translateY(0px); }
}`}
      </style>
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.16), transparent 50%), radial-gradient(circle at 80% 10%, rgba(34,197,94,0.12), transparent 45%), radial-gradient(circle at 80% 80%, rgba(236,72,153,0.12), transparent 50%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.18) 1px, transparent 1px), radial-gradient(rgba(59,130,246,0.12) 1px, transparent 1px)",
          backgroundSize: "120px 120px, 200px 200px",
          animation: "drift 28s ease-in-out infinite",
        }}
      />
      <div
        className="absolute left-10 top-24 h-28 w-28 rounded-full bg-primary/20 blur-3xl"
        style={{ animation: "floaty 10s ease-in-out infinite" }}
      />
      <div
        className="absolute right-16 bottom-16 h-32 w-32 rounded-full bg-cyan-400/15 blur-3xl"
        style={{ animation: "floaty 12s ease-in-out infinite" }}
      />
      <div className="absolute top-6 right-6 z-20">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-xl bg-background/70 backdrop-blur border border-border"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
      </div>
      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center mb-4">
              <img src="/logo.png" alt="Vexa logo" className="w-16 h-16 object-contain" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">VEXA</h1>
            <p className="text-muted-foreground text-sm mt-1">Radiology Information System</p>
          </div>
          <div className="medical-card bg-background/80 backdrop-blur">
            <h2 className="text-lg font-semibold text-foreground text-center mb-6">Sign in to your account</h2>
            {sessionNotice && (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{sessionNotice}</span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-sm font-medium text-foreground">Username</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    className="pl-10 h-11 rounded-xl bg-background/70"
                    autoComplete="username"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium text-foreground">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="pl-10 h-11 rounded-xl bg-background/70"
                    autoComplete="current-password"
                  />
                </div>
              </div>
              <Button
                type="submit"
                className="w-full rounded-xl gradient-medical border-0"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Activity className="w-4 h-4 mr-2 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 mr-2" />
                    Sign In
                  </>
                )}
              </Button>
            </form>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or</span>
              </div>
            </div>
            <div ref={googleButtonRef} className="flex justify-center min-h-[40px]"></div>
            {!import.meta.env.VITE_GOOGLE_CLIENT_ID && (
              <p className="text-xs text-muted-foreground text-center">Google login is not configured</p>
            )}
          </div>
          <p className="mt-4 text-center text-xs font-semibold text-white/80 drop-shadow-sm">
            {facility.name} - {facility.address}
          </p>
          <p className="mt-2 text-center text-[11px] italic text-white/45 drop-shadow-sm">
            {appVersion}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
