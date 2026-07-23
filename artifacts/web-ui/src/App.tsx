import { Suspense, lazy } from "react";
  import { Switch, Route, Router as WouterRouter } from "wouter";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { Toaster } from "@/components/ui/toaster";
  import { TooltipProvider } from "@/components/ui/tooltip";
  import { Layout } from "@/components/layout";
  import { AuthProvider, useAuth } from "@/contexts/auth-context";
  import { PollPausedProvider } from "@/contexts/poll-paused-context";
  import { ThemeProvider } from "@/contexts/theme-context";
  import { LangProvider } from "@/contexts/lang-context";
  import { Loader2 } from "lucide-react";

  const Home        = lazy(() => import("@/pages/Home"));
  const TaskForm    = lazy(() => import("@/pages/TaskForm"));
  const TaskDetail  = lazy(() => import("@/pages/TaskDetail"));
  const LogDetail   = lazy(() => import("@/pages/LogDetail"));
  const Settings    = lazy(() => import("@/pages/Settings"));
  const Status      = lazy(() => import("@/pages/Status"));
  const Recorder    = lazy(() => import("@/pages/Recorder"));
  const NotFound    = lazy(() => import("@/pages/not-found"));
  const LoginPage   = lazy(() => import("@/pages/LoginPage"));
  const SetupPage   = lazy(() => import("@/pages/SetupPage"));
  const Credentials = lazy(() => import("@/pages/Credentials"));
  const LogsExplorer = lazy(() => import("@/pages/LogsExplorer"));
  const FingerprintProfiles = lazy(() => import("@/pages/FingerprintProfiles"));
  const ProxyProfiles = lazy(() => import("@/pages/ProxyProfiles"));
  const ProviderInstances = lazy(() => import("@/pages/ProviderInstances"));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });

  const PageLoader = () => (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );

  function Router() {
    return (
      <Layout>
        <Suspense fallback={<PageLoader />}>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/tasks/new" component={TaskForm} />
            <Route path="/tasks/:id/edit" component={TaskForm} />
            <Route path="/tasks/:id/logs/:logId" component={LogDetail} />
            <Route path="/tasks/:id" component={TaskDetail} />
            <Route path="/settings" component={Settings} />
            <Route path="/status" component={Status} />
            <Route path="/recorder" component={Recorder} />
            <Route path="/credentials" component={Credentials} />
            <Route path="/fingerprints" component={FingerprintProfiles} />
            <Route path="/proxies" component={ProxyProfiles} />
            <Route path="/provider-instances" component={ProviderInstances} />
            <Route path="/logs" component={LogsExplorer} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </Layout>
    );
  }

  function AuthGate() {
    const { authenticated, needsSetup, loading, login } = useAuth();
    if (loading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (needsSetup) return <Suspense fallback={<PageLoader />}><SetupPage /></Suspense>;
    if (!authenticated) return <Suspense fallback={<PageLoader />}><LoginPage onLogin={login} /></Suspense>;
    return <Router />;
  }

  function App() {
    return (
      <ThemeProvider>
        <LangProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <AuthProvider>
                  <PollPausedProvider>
                    <AuthGate />
                  </PollPausedProvider>
                </AuthProvider>
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        </LangProvider>
      </ThemeProvider>
    );
  }

  export default App;
  