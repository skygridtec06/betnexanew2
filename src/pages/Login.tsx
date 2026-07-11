import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { AlertCircle, Lock, Phone } from "lucide-react";
import Logo from "@/assets/betnexa official logo .jpeg";
import { useUserManagement } from "@/context/UserManagementContext";
import { useUser } from "@/context/UserContext";
import { useBets } from "@/context/BetContext";

export default function Login() {
  const navigate = useNavigate();
  const { users } = useUserManagement();
  const { login, loginWithSupabase } = useUser();
  const { syncBalance } = useBets();

  const [formData, setFormData] = useState({
    phone: "",
    password: "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [isBanned, setIsBanned] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('banned') === '1';
  });
  const [bannedUserInfo, setBannedUserInfo] = useState<any>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const info = params.get('info');
      return info ? JSON.parse(decodeURIComponent(info)) : null;
    } catch { return null; }
  });

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (!formData.phone.trim()) {
      newErrors.phone = "Phone number is required";
    }

    if (!formData.password) {
      newErrors.password = "Password is required";
    } else if (!/^\d{4}$/.test(formData.password)) {
      newErrors.password = "Password must be exactly 4 digits";
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    setGlobalError("");

    try {
      // Try Supabase login first (for all users including admins registered in database)
      // This supports both regular users and admin users from Supabase
      const dbUser = await loginWithSupabase(formData.phone, formData.password);
      
      if (dbUser) {
        // Check if user is admin in database
        if (dbUser.isAdmin || dbUser.is_admin === true) {
          // Admin login - store with admin flag
          const adminUser = {
            ...dbUser,
            level: "Administrator",
            isAdmin: true,
          };
          localStorage.setItem('betnexa_user', JSON.stringify(adminUser));
          setIsSubmitting(false);
          navigate("/muleiadmin");
          return;
        } else {
          // Regular user login - create session
          syncBalance(dbUser.accountBalance);
          setIsSubmitting(false);
          
          // Restore pending picks from URL if they exist
          try {
            const pendingPicks = sessionStorage.getItem("pendingPicks");
            if (pendingPicks) {
              navigate(`/?picks=${pendingPicks}`);
              sessionStorage.removeItem("pendingPicks");
            } else {
              navigate("/");
            }
          } catch (error) {
            navigate("/");
          }
          return;
        }
      }

      // Fallback: Check for hardcoded admin credentials (legacy support)
      if (formData.phone === "0714945142" && formData.password === "4306") {
        const adminUser = {
          id: `admin_${formData.phone}`,
          name: "Mulei Admin",
          email: "muleiadmin@betnexa.com",
          phone: formData.phone,
          password: formData.password,
          username: "muleiadmin",
          verified: true,
          level: "Administrator",
          joinDate: new Date().toISOString().split('T')[0],
          totalBets: 0,
          totalWinnings: 0,
          accountBalance: 0,
          withdrawalActivated: false,
          withdrawalActivationDate: null,
          isAdmin: true,
        };

        localStorage.setItem('betnexa_user', JSON.stringify(adminUser));
        setIsSubmitting(false);
        navigate("/muleiadmin");
        return;
      }

      // Fallback to local user search if Supabase login fails
      const localUser = users.find(
        (u) => u.phone === formData.phone && u.password === formData.password
      );

      if (!localUser) {
        setGlobalError(
          "Invalid phone number or password. Make sure you signed up first."
        );
        setIsSubmitting(false);
        return;
      }

      // Login with local user (with session)
      await login({
        id: localUser.id,
        name: localUser.name,
        email: localUser.email,
        phone: localUser.phone,
        password: localUser.password,
        username: localUser.username,
        verified: localUser.verified,
        level: localUser.level,
        joinDate: localUser.joinDate,
        totalBets: localUser.totalBets,
        totalWinnings: localUser.totalWinnings,
        accountBalance: localUser.accountBalance,
        withdrawalActivated: localUser.withdrawalActivated,
        withdrawalActivationDate: localUser.withdrawalActivationDate,
      });

      syncBalance(localUser.accountBalance);
      setIsSubmitting(false);
      
      // Restore pending picks from URL if they exist
      try {
        const pendingPicks = sessionStorage.getItem("pendingPicks");
        if (pendingPicks) {
          navigate(`/?picks=${pendingPicks}`);
          sessionStorage.removeItem("pendingPicks");
        } else {
          navigate("/");
        }
      } catch (error) {
        navigate("/");
      }
    } catch (error: any) {
      console.error("Login error:", error);
      if (error?.message === 'ACCOUNT_BANNED') {
        setIsBanned(true);
        setBannedUserInfo(error.userInfo || { phone: formData.phone });
        setGlobalError("");
      } else {
        setGlobalError(
          "Login failed. Please check your credentials and try again."
        );
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 bg-background/95 backdrop-blur-md">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-2 w-fit cursor-pointer">
            <img src={Logo} alt="BETNEXA Logo" className="h-10 w-10 rounded-lg app-logo" />
            <span className="font-display text-lg font-bold tracking-wider text-foreground">
              BET<span className="text-primary">NEXA</span>
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <Card className="w-full max-w-md border-primary/30 bg-card p-8 neon-border">
          <div className="mb-8 text-center">
            <h1 className="font-display text-2xl font-bold text-foreground">Login</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Welcome back to BETNEXA
            </p>
          </div>

          {isBanned && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-5 text-center">
              <div className="text-3xl mb-2">🚫</div>
              <h3 className="text-base font-bold text-red-500 mb-1">Account Banned</h3>
              <p className="text-sm text-red-400 mb-4">
                Your account has been banned. Please contact support for assistance.
              </p>
              <a
                href="https://t.me/betnexasupport"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-sky-700 transition-colors"
              >
                💬 Contact Support
              </a>
            </div>
          )}

          {globalError && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {globalError}
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            {/* Phone Number */}
            <div>
              <label className="text-sm font-medium text-foreground">Phone Number</label>
              <div className="relative mt-1.5">
                <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="tel"
                  placeholder="e.g., 254712345678"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="pl-10"
                />
              </div>
              {errors.phone && (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {errors.phone}
                </div>
              )}
            </div>

            {/* Password */}
            <div>
              <label className="text-sm font-medium text-foreground">Password (4 Digits)</label>
              <div className="relative mt-1.5">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="password"
                  placeholder="Enter your 4-digit password"
                  inputMode="numeric"
                  maxLength={4}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value.replace(/\D/g, "") })}
                  className="pl-10"
                />
              </div>
              {errors.password && (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {errors.password}
                </div>
              )}
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              variant="hero"
              className="w-full mt-6"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Logging in..." : "Login"}
            </Button>
          </form>

          {/* Signup Link */}
          <div className="mt-6 text-center text-sm text-muted-foreground">
            Don't have an account?{" "}
            <Link to="/signup" className="text-primary hover:underline font-medium">
              Sign up here
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
