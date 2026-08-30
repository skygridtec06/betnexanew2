import { Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { BetProvider } from "./context/BetContext";
import { UserProvider } from "./context/UserContext";
import { MatchProvider } from "./context/MatchContext";
import { OddsProvider } from "./context/OddsContext";
import { UserManagementProvider } from "./context/UserManagementContext";
import { TransactionProvider } from "./context/TransactionContext";
import { PresenceProvider } from "./context/PresenceContext";
import { ThemeProvider } from "./context/ThemeContext";
import { BalanceSyncProvider } from "./components/BalanceSyncProvider";
import { PresenceTracker } from "./components/PresenceTracker";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AdminProtectedRoute } from "./components/AdminProtectedRoute";
import Index from "./pages/Index";
import AdminPortal from "./pages/AdminPortal";
import Finance from "./pages/Finance";
import MyBets from "./pages/MyBets";
import History from "./pages/History";
import Profile from "./pages/Profile";
import TermsAndConditions from "./pages/TermsAndConditions";
import Signup from "./pages/Signup";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import PriorityWithdrawal from "./pages/PriorityWithdrawal";
import AdminFinance from "./pages/AdminFinance";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,      // data stays fresh for 30s — no refetch on remount
      gcTime: 5 * 60 * 1000,    // keep in memory for 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Loading fallback component
const LoadingPage = () => (
  <div className="flex items-center justify-center min-h-screen bg-background">
    <div className="text-center">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
      <p className="text-foreground text-lg">Loading...</p>
    </div>
  </div>
);

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
      <TooltipProvider>
        <UserManagementProvider>
          <TransactionProvider>
            <UserProvider>
              <PresenceProvider>
                <PresenceTracker>
                  <BetProvider>
                    <MatchProvider>
                      <OddsProvider>
                        <BalanceSyncProvider>
                          <Toaster />
                          <Sonner />
                          <BrowserRouter>
                            <Suspense fallback={<LoadingPage />}>
                              <Routes>
                                <Route path="/login" element={<Login />} />
                                <Route path="/signup" element={<Signup />} />
                                {/* Public routes - show games and odds to everyone, but redirect to signup for betting */}
                                <Route path="/" element={<Index />} />
                                <Route path="/basketball" element={<Index sport="basketball" />} />
                                <Route path="/tennis" element={<Index sport="tennis" />} />
                                <Route path="/cricket" element={<Index sport="cricket" />} />
                                <Route path="/boxing" element={<Index sport="boxing" />} />
                                {/* Protected routes - redirect to login if not authenticated */}
                                <Route path="/finance" element={<ProtectedRoute element={<Finance />} />} />
                                <Route path="/my-bets" element={<ProtectedRoute element={<MyBets />} />} />
                                <Route path="/history" element={<ProtectedRoute element={<History />} />} />
                                <Route path="/profile" element={<ProtectedRoute element={<Profile />} />} />
                                <Route path="/priority-withdrawal" element={<ProtectedRoute element={<PriorityWithdrawal />} />} />
                                <Route path="/terms" element={<TermsAndConditions />} />
                                <Route path="/admin-finance" element={<AdminProtectedRoute element={<AdminFinance />} />} />
                                <Route path="/muleiadmin" element={<AdminProtectedRoute element={<AdminPortal />} />} />
                                {/* Betslip short code route - /nnnnn format (must be before wildcard) */}
                                <Route path="/:code" element={<Index />} />
                                <Route path="*" element={<NotFound />} />
                              </Routes>
                            </Suspense>
                          </BrowserRouter>
                        </BalanceSyncProvider>
                      </OddsProvider>
                    </MatchProvider>
                  </BetProvider>
                </PresenceTracker>
              </PresenceProvider>
            </UserProvider>
          </TransactionProvider>
        </UserManagementProvider>
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

export default App;
