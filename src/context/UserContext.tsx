import { createContext, useContext, useState, ReactNode, useEffect } from "react";
import supabase from "@/services/supabaseClient";
import { sessionService } from "@/services/sessionService";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  password: string;
  username: string;
  verified: boolean;
  level: string;
  joinDate: string;
  totalBets: number;
  totalWinnings: number;
  accountBalance: number;
  stakeableBalance: number;
  withdrawableBalance: number;
  withdrawalActivated: boolean;
  withdrawalActivationDate: string | null;
  isAdmin?: boolean;
  betnexaId?: string | null;
}

interface UserContextType {
  user: UserProfile | null;
  isLoggedIn: boolean;
  sessionId: string | null;
  updateUser: (userData: Partial<UserProfile>) => void;
  login: (userData: UserProfile) => Promise<void>;
  logout: () => Promise<void>;
  loginWithSupabase: (phone: string, password: string) => Promise<UserProfile | null>;
  signupWithSupabase: (userData: any) => Promise<UserProfile | null>;
  refreshUserData: () => Promise<void>;  // Refresh user data from backend
}

const UserContext = createContext<UserContextType | undefined>(undefined);

const DEFAULT_USER: UserProfile = {
  id: "user1",
  name: "John Doe",
  email: "john.doe@example.com",
  phone: "+254712345678",
  password: "1234",
  username: "john_doe",
  verified: true,
  level: "Gold Member",
  joinDate: "2024-06-15",
  totalBets: 245,
  totalWinnings: 15750,
  accountBalance: 10000,
  stakeableBalance: 10000,
  withdrawableBalance: 0,
  withdrawalActivated: false,
  withdrawalActivationDate: null,
  betnexaId: null,
};

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Load user and verify session on mount
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        // Try sessionStorage first (per-tab/window isolation in multi-login)
        const sessionUser = sessionStorage.getItem('betnexa_user');
        const sessionSession = sessionStorage.getItem('betnexa_session');
        
        console.log('🔐 Checking for session in sessionStorage (per-tab)...');
        console.log('   Session user:', !!sessionUser);
        console.log('   Session data:', !!sessionSession);
        
        // Fallback to localStorage if no sessionStorage
        const savedUser = sessionUser || localStorage.getItem('betnexa_user');
        const savedSession = sessionSession || localStorage.getItem('betnexa_session');
        
        console.log('   Fallback to localStorage:', !sessionUser && !!savedUser);
        
        if (savedUser && savedSession) {
          try {
            const userData = JSON.parse(savedUser);
            const sessionData = JSON.parse(savedSession);
            
            console.log('✅ Found saved user:', { username: userData.username, phone: userData.phone, email: userData.email });
            
            // Validate required fields for refresh to work
            if (!userData.phone) {
              console.warn('⚠️ Saved user missing phone field, clearing session');
              sessionStorage.removeItem('betnexa_user');
              sessionStorage.removeItem('betnexa_session');
              localStorage.removeItem('betnexa_user');
              localStorage.removeItem('betnexa_session');
              setIsAuthReady(true);
              return;
            }
            
            // Restore session immediately from storage (faster than database check)
            setUser(userData);
            setSessionId(sessionData.sessionId);
            setIsLoggedIn(true);
            setIsAuthReady(true);
            
            console.log('✅ Session restored, phone available:', userData.phone);
            
            // Verify session is still valid in background
            const currentSession = sessionService.getCurrentSession();
            if (!currentSession) {
              console.warn('⚠️ Session validation failed, but keeping local session active');
              // Don't immediately log out - let the background check happen
            } else {
              // Update session activity
              await sessionService.updateSessionActivity(currentSession.sessionId).catch(err => {
                console.warn('⚠️ Failed to update session activity:', err);
                // Continue anyway, don't interrupt user session
              });
            }
          } catch (parseError) {
            console.error('❌ Error parsing saved session:', parseError);
            sessionStorage.removeItem('betnexa_user');
            sessionStorage.removeItem('betnexa_session');
            localStorage.removeItem('betnexa_user');
            localStorage.removeItem('betnexa_session');
            setIsAuthReady(true);
          }
        } else {
          console.log('ℹ️ No saved session found');
          setIsAuthReady(true);
        }
      } catch (error) {
        console.error('❌ Failed to initialize auth:', error);
        setIsAuthReady(true);
      }
    };
    
    initializeAuth();
  }, []);

  // Periodic ban check - force logout if user gets banned
  useEffect(() => {
    if (!user?.phone || !isLoggedIn) return;

    const checkBanStatus = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
        const res = await fetch(`${apiUrl}/api/auth/ban-check?phone=${encodeURIComponent(user.phone)}`);
        const data = await res.json();
        if (data.banned) {
          console.log('🚫 User is banned, forcing logout');
          const bannedInfo = encodeURIComponent(JSON.stringify({
            username: user.username || user.name,
            phone: user.phone,
            email: user.email,
            betnexaId: user.betnexaId,
          }));
          setUser(null);
          setSessionId(null);
          setIsLoggedIn(false);
          sessionStorage.removeItem('betnexa_user');
          sessionStorage.removeItem('betnexa_session');
          localStorage.removeItem('betnexa_user');
          localStorage.removeItem('betnexa_session');
          window.location.href = `/login?banned=1&info=${bannedInfo}`;
        }
      } catch (e) {
        // Silently fail - don't disrupt user on network errors
      }
    };

    // Ban check increased from 30s to 2 minutes (reduces from 2 req/min to 0.5 req/min)
    // User ban status already checked on login, re-check every 2 minutes is sufficient
    // This change: -1.5 requests/min per user
    const interval = setInterval(checkBanStatus, 120000);
    return () => clearInterval(interval);
  }, [user?.phone, isLoggedIn]);

  const login = async (userData: UserProfile) => {
    try {
      console.log(`\n🔐 [login] Setting user session`);
      console.log(`   Username: ${userData.username}`);
      console.log(`   Phone: ${userData.phone}`);
      console.log(`   Balance: KSH ${userData.accountBalance}`);
      console.log(`   Total Winnings: KSH ${userData.totalWinnings}`);
      
      // Create session for this device
      const session = await sessionService.createSession(userData.id);
      
      if (session) {
        setUser(userData);
        setSessionId(session.sessionId);
        setIsLoggedIn(true);
        
        // Persist to both sessionStorage (per-tab isolation) and localStorage (for multi-device persistence)
        sessionStorage.setItem('betnexa_user', JSON.stringify(userData));
        sessionStorage.setItem('betnexa_session', JSON.stringify(session));
        localStorage.setItem('betnexa_user', JSON.stringify(userData));
        localStorage.setItem('betnexa_session', JSON.stringify(session));
        
        console.log(`✅ Login successful on device: ${session.deviceName}`);
        console.log(`✅ Balance stored in localStorage: KSH ${userData.accountBalance}`);
        console.log(`✅ Session data saved to sessionStorage (per-tab isolation)`);
      } else {
        throw new Error('Failed to create session');
      }
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  };

  const logout = async () => {
    try {
      // Clear session from database if available
      if (sessionId) {
        await sessionService.clearSession();
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      setSessionId(null);
      setIsLoggedIn(false);
      // Clear from both sessionStorage (per-tab) and localStorage (persistent)
      sessionStorage.removeItem('betnexa_user');
      sessionStorage.removeItem('betnexa_session');
      localStorage.removeItem('betnexa_user');
      localStorage.removeItem('betnexa_session');
      console.log('✅ User logged out successfully');
    }
  };

  const updateUser = (userData: Partial<UserProfile>) => {
    if (user) {
      const updatedUser = { ...user, ...userData };
      setUser(updatedUser);
      // Persist to both sessionStorage and localStorage
      sessionStorage.setItem('betnexa_user', JSON.stringify(updatedUser));
      localStorage.setItem('betnexa_user', JSON.stringify(updatedUser));
    }
  };

  // Login with backend API
  const loginWithSupabase = async (phone: string, password: string): Promise<UserProfile | null> => {
    try {
      console.log(`\n🔐 [loginWithSupabase] Attempting login for: ${phone}`);
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke'}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone, password }),
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        console.error('❌ Login failed:', data.message);
        if (data.banned) {
          const err: any = new Error('ACCOUNT_BANNED');
          err.userInfo = data.userInfo;
          throw err;
        }
        return null;
      }

      console.log(`✅ Login successful, received user data from server`);
      console.log(`   Phone: ${data.user.phone}`);
      console.log(`   Balance from DB: KSH ${data.user.accountBalance}`);
      console.log(`   Total Winnings from DB: KSH ${data.user.totalWinnings}`);

      // Create session for this device
      await login(data.user);
      return data.user;
    } catch (error: any) {
      console.error('Login error:', error);
      if (error?.message === 'ACCOUNT_BANNED') throw error;
      return null;
    }
  };

  // Signup with backend API
  const signupWithSupabase = async (userData: any): Promise<UserProfile | null> => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke'}/api/auth/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: userData.username || userData.name,
          email: userData.email,
          phone: userData.phone,
          password: userData.password,
        }),
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        console.error('Signup failed:', data.message);
        return null;
      }

      // Create session for this device
      await login(data.user);
      return data.user;
    } catch (error) {
      console.error('Signup error:', error);
      return null;
    }
  };

  // Refresh user data from backend (for admin updates to reflect in real-time)
  const refreshUserData = async () => {
    if (!user || !user.phone) {
      console.warn('⚠️ Cannot refresh: user or phone missing', { user: !!user, phone: user?.phone });
      return false;
    }
    
    // Verify phone in current user state matches localStorage (detect cross-contamination)
    const storedUser = sessionStorage.getItem('betnexa_user') || localStorage.getItem('betnexa_user');
    if (storedUser) {
      try {
        const storedData = JSON.parse(storedUser);
        if (storedData.phone !== user.phone) {
          console.error(`❌ CRITICAL: Phone mismatch detected! User phone (${user.phone}) != Stored phone (${storedData.phone})`);
          console.error('  This indicates multi-login cross-contamination. Clearing corrupted session.');
          sessionStorage.removeItem('betnexa_user');
          sessionStorage.removeItem('betnexa_session');
          localStorage.removeItem('betnexa_user');
          localStorage.removeItem('betnexa_session');
          setIsLoggedIn(false);
          return false;
        }
      } catch (e) {
        console.warn('⚠️ Could not parse stored user for verification');
      }
    }
    
    try {
      console.log(`🔄 Starting refresh for phone: ${user.phone}`);
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const profileUrl = `${apiUrl}/api/auth/profile/${encodeURIComponent(user.phone)}`;
      console.log(`   URL: ${profileUrl}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      const response = await fetch(profileUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      console.log(`   Response status: ${response.status}`);

      if (!response.ok) {
        console.warn(`⚠️ Refresh failed (HTTP ${response.status})`, response.statusText);
        return false;
      }

      const data = await response.json();
      console.log(`   Response data:`, data);

      if (!data.success || !data.user) {
        console.warn('⚠️ Refresh response invalid:', data);
        return false;
      }

      // Verify the refreshed user is the same as current user (prevent cross-user updates)
      if (data.user.phone !== user.phone) {
        console.error(`❌ CRITICAL: Response phone (${data.user.phone}) doesn't match current user phone (${user.phone})`);
        console.error('  Ignoring this response to prevent cross-user contamination');
        return false;
      }

      // Compare old and new data
      const changes = {
        balance: user.accountBalance !== data.user.accountBalance,
        username: user.username !== data.user.username,
        email: user.email !== data.user.email,
        phone: user.phone !== data.user.phone,
      };

      console.log(`✅ User data fetched successfully for ${user.phone}, changes:`, changes);
      
      // Update user data - this will also update localStorage
      updateUser(data.user);
      
      // If balance changed, notify BetContext through localStorage event
      if (changes.balance) {
        console.log(`💰 Balance updated: ${user.accountBalance} → ${data.user.accountBalance}`);
        // Dispatch a custom event that BetContext can listen to
        window.dispatchEvent(new CustomEvent('balance_updated', { 
          detail: { 
            userId: user.id,
            newBalance: data.user.accountBalance 
          } 
        }));
      }
      
      return true;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          console.warn('⚠️ Refresh request timed out');
        } else {
          console.warn('⚠️ Error refreshing user data:', error.message);
        }
      } else {
        console.warn('⚠️ Unknown error refreshing user data:', error);
      }
      return false;
    }
  };

  // Periodic refresh of user data every 15 seconds when logged in
  useEffect(() => {
    if (!isLoggedIn || !user || !user.phone) {
      console.log('⏱️ Refresh disabled:', { isLoggedIn, hasUser: !!user, hasPhone: !!user?.phone });
      return;
    }

    // Capture phone at setup time to ensure this interval refreshes the correct user
    const userPhone = user.phone;
    console.log(`⏱️ Setting up periodic refresh for user: ${userPhone}`);
    
    // Create a wrapper to ensure refreshUserData has access to current user
    const doRefresh = async () => {
      // Double-check phone is still the same (prevents cross-contamination in multi-login)
      if (!user?.phone || user.phone !== userPhone) {
        console.warn(`⚠️ Phone changed from ${userPhone} to ${user?.phone}, stopping old interval`);
        return; // Don't refresh if phone has changed (user switched or logged out)
      }
      
      console.log(`⏱️ Refreshing data for user: ${userPhone}`);
      try {
        await refreshUserData();
      } catch (err) {
        console.warn('⚠️ Refresh error caught:', err);
      }
    };

    // Refresh immediately on setup
    console.log(`⏱️ Running initial refresh for ${userPhone}...`);
    doRefresh();

    // Listen for balance updates from BetContext (e.g., when a bet is settled)
    const handleBalanceUpdate = (event: Event) => {
      const customEvent = event as CustomEvent;
      console.log(`💰 UserContext: Detected balance update from BetContext, refreshing user data...`);
      doRefresh();
    };

    window.addEventListener('balance_updated', handleBalanceUpdate);

    // Then refresh every 15 seconds - only for this specific user
    const refreshInterval = setInterval(() => {
      console.log(`⏱️ Scheduled refresh triggered for ${userPhone}`);
      doRefresh();
    }, 15000);

    return () => {
      clearInterval(refreshInterval);
      window.removeEventListener('balance_updated', handleBalanceUpdate);
      console.log(`⏹️ Stopped periodic refresh for ${userPhone}`);
    };
  }, [isLoggedIn, user, user?.phone, refreshUserData]);

  return (
    <UserContext.Provider
      value={{
        user,
        isLoggedIn,
        sessionId,
        updateUser,
        login,
        logout,
        loginWithSupabase,
        signupWithSupabase,
        refreshUserData,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}




