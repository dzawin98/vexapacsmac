import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import AppSidebar from "./AppSidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import LoadingScreen from "./LoadingScreen";

const AppLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const [routeLoadingMounted, setRouteLoadingMounted] = useState(false);
  const [routeLoadingVisible, setRouteLoadingVisible] = useState(false);
  const isFirstRender = useRef(true);
  const isFlushPage =
    location.pathname === "/mwl/technologist" ||
    location.pathname === "/dose/monitor" ||
    location.pathname === "/worklist" ||
    location.pathname === "/reporting" ||
    location.pathname === "/distribution";

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setRouteLoadingMounted(true);
    const enterFrame = window.requestAnimationFrame(() => {
      setRouteLoadingVisible(true);
    });
    const hideTimer = window.setTimeout(() => {
      setRouteLoadingVisible(false);
    }, 420);
    const unmountTimer = window.setTimeout(() => {
      setRouteLoadingMounted(false);
    }, 720);
    return () => {
      window.cancelAnimationFrame(enterFrame);
      window.clearTimeout(hideTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [location.pathname]);

  return (
    <div className="relative flex h-screen w-full bg-background overflow-hidden">
      {routeLoadingMounted && <LoadingScreen visible={routeLoadingVisible} />}
      <AppSidebar />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="p-0 w-72 sm:w-80">
          <AppSidebar variant="mobile" onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <main className="min-w-0 relative flex-1 h-screen overflow-y-auto overflow-x-hidden">
        <div className="md:hidden sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
          <div className="flex items-center justify-between h-14 px-4">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-xl text-muted-foreground hover:text-foreground"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="VEXA-RIS logo" className="w-7 h-7 object-contain" />
              <span className="text-sm font-semibold text-foreground">VEXA-RIS</span>
            </div>
            <div className="w-10" aria-hidden="true" />
          </div>
        </div>
        <div
          className={
            isFlushPage
              ? "min-h-full min-w-0"
              : "px-4 py-4 sm:p-6 max-w-[1600px] mx-auto min-h-full"
          }
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default AppLayout;
