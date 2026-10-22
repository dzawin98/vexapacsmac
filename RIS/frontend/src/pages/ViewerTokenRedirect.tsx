import LoadingScreen from "@/components/LoadingScreen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveBackendUrl } from "@/lib/backendUrl";
import { AlertCircle, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";

const BACKEND_URL = resolveBackendUrl();

const ViewerTokenRedirect = () => {
  const { token, linkKey } = useParams<{ token: string; linkKey?: string }>();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  const safeToken = useMemo(() => String(token || "").trim(), [token]);

  useEffect(() => {
    if (!safeToken) {
      setError("Viewer token was not found.");
      return;
    }

    let cancelled = false;

    const resolveToken = async () => {
      try {
        const keyPath = linkKey ? `/${encodeURIComponent(linkKey)}` : "";
        const response = await fetch(`${BACKEND_URL}/viewer/token/${encodeURIComponent(safeToken)}${keyPath}${location.search || ""}`);
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to open viewer.");
        }
        const nextUrl = typeof payload?.redirectUrl === "string" ? payload.redirectUrl : "";
        if (!nextUrl) {
          throw new Error("Viewer link is not valid.");
        }
        if (cancelled) return;
        setRedirectUrl(nextUrl);
        window.location.replace(nextUrl);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to open viewer.");
      }
    };

    void resolveToken();

    return () => {
      cancelled = true;
    };
  }, [linkKey, location.search, safeToken]);

  if (!error) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg rounded-2xl border-border/60 shadow-lg">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-3 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <CardTitle className="text-xl">Viewer cannot be opened</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{error}</p>
          {redirectUrl ? (
            <Button asChild className="rounded-xl">
              <a href={redirectUrl} target="_self" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Try opening again
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
};

export default ViewerTokenRedirect;
