import { createContext, useContext, useState, ReactNode, useEffect } from "react";

export interface PlacedBet {
  id: string;
  betId: string;
  user_id?: string;
  username?: string;
  phone_number?: string;
  date: string;
  time: string;
  stake: number;
  potentialWin: number;
  totalOdds: number;
  selections: Array<{
    matchId: string;
    match: string;
    type: string;
    market: string;
    odds: number;
  }>;
  status: "Open" | "Closed" | "Won" | "Lost" | "Void";
  amountWon?: number;
}

interface BetContextType {
  bets: PlacedBet[];
  addBet: (bet: PlacedBet) => void;
  removeBet: (betId: string) => void;
  balance: number;
  stakeableBalance: number;
  withdrawableBalance: number;
  deposit: (amount: number) => void;
  withdraw: (amount: number) => boolean;
  placeBet: (betAmount: number) => boolean;
  updateBetStatus: (betId: string, status: PlacedBet["status"], amountWon?: number) => Promise<{ success: boolean; error?: string; data?: any }>;
  setBalance: (amount: number) => void;
  setStakeableBalance: (amount: number) => void;
  setWithdrawableBalance: (amount: number) => void;
  syncBalance: (newBalance: number) => void;
  setBets: (bets: PlacedBet[]) => void;
  fetchAllBets: () => Promise<{ success: boolean; error?: string }>;
}

const BetContext = createContext<BetContextType | undefined>(undefined);

export function BetProvider({ children }: { children: ReactNode }) {
  const [bets, setBets] = useState<PlacedBet[]>([]);

  // Initialize balances from localStorage user data on mount
  const [balance, setBalance] = useState<number>(() => {
    try {
      const savedUser = sessionStorage.getItem('betnexa_user') || localStorage.getItem('betnexa_user');
      if (savedUser) {
        const user = JSON.parse(savedUser);
        return user.accountBalance || 0;
      }
    } catch (error) {
      console.warn('âš ï¸ Failed to initialize balance from localStorage');
    }
    return 0;
  });

  const [stakeableBalance, setStakeableBalance] = useState<number>(() => {
    try {
      const savedUser = sessionStorage.getItem('betnexa_user') || localStorage.getItem('betnexa_user');
      if (savedUser) {
        const user = JSON.parse(savedUser);
        return user.stakeableBalance || user.accountBalance || 0;
      }
    } catch (error) {
      console.warn('âš ï¸ Failed to initialize stakeable balance from localStorage');
    }
    return 0;
  });

  const [withdrawableBalance, setWithdrawableBalance] = useState<number>(() => {
    try {
      const savedUser = sessionStorage.getItem('betnexa_user') || localStorage.getItem('betnexa_user');
      if (savedUser) {
        const user = JSON.parse(savedUser);
        return user.withdrawableBalance || 0;
      }
    } catch (error) {
      console.warn('âš ï¸ Failed to initialize withdrawable balance from localStorage');
    }
    return 0;
  });

  // Listen for balance updates from UserContext (e.g., when admin edits balance in database)
  useEffect(() => {
    const handleBalanceUpdate = (event: CustomEvent) => {
      const { newBalance } = event.detail;
      if (typeof newBalance === 'number') {
        console.log(`ðŸ’° BetContext: Syncing balance from UserContext: ${balance} â†’ ${newBalance}`);
        setBalance(newBalance);
      }
    };

    window.addEventListener('balance_updated', handleBalanceUpdate as EventListener);
    return () => window.removeEventListener('balance_updated', handleBalanceUpdate as EventListener);
  }, [balance]);

  const addBet = (bet: PlacedBet) => {
    setBets([bet, ...bets]);
  };

  const removeBet = (betId: string) => {
    setBets(bets.filter((b) => b.id !== betId));
  };

  const deposit = (amount: number) => {
    if (amount > 0) {
      setBalance((prev) => prev + amount);
    }
  };

  const withdraw = (amount: number): boolean => {
    if (amount > 0 && balance >= amount) {
      setBalance((prev) => prev - amount);
      return true;
    }
    return false;
  };

  const placeBet = (betAmount: number): boolean => {
    if (betAmount > 0 && balance >= betAmount) {
      setBalance((prev) => prev - betAmount);
      return true;
    }
    return false;
  };

  const updateBetStatus = async (betId: string, status: PlacedBet["status"], amountWon?: number) => {
    console.log(`\nðŸ”„ [BetContext.updateBetStatus] Starting update`);
    console.log(`   Bet ID: ${betId}`);
    console.log(`   New Status: ${status}`);
    console.log(`   Amount Won: ${amountWon || 'N/A'}`);
    
    // Update local state first
    setBets((prev) =>
      prev.map((bet) =>
        bet.id === betId
          ? {
              ...bet,
              status,
              amountWon: amountWon || bet.amountWon,
            }
          : bet
      )
    );
    console.log(`   âœ“ Local state updated`);

    // Do not credit main balance locally on Won; backend controls wallet settlement.

    // Now sync with backend database
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexanewbackend.vercel.app';
      const endpoint = `${apiUrl}/api/bets/${betId}/status`;
      
      console.log(`   ðŸ“¡ Calling API: PUT ${endpoint}`);
      console.log(`   ðŸ“¦ Request body: { status: "${status}", amountWon: ${amountWon || 0} }`);
      
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          amountWon: amountWon || 0
        })
      });

      console.log(`   ðŸ“¥ API Response status: ${response.status}`);
      const data = await response.json();
      console.log(`   ðŸ“¥ API Response data:`, data);

      if (!response.ok) {
        console.error(`   âŒ API returned error: ${data.error}`);
        return {
          success: false,
          error: data.error || 'Failed to update bet status'
        };
      }

      console.log(`   âœ… Bet ${betId} status updated to ${status} in database`);
      
      // If bet won and we have updated user data, sync the balance
      if (status === 'Won' && data.updatedUser && data.updatedUser.account_balance !== undefined) {
        const serverBalance = data.updatedUser.account_balance;
        console.log(`   ðŸ’¾ Server returned updated balance: KSH ${serverBalance}`);
        console.log(`   âœ“ Syncing server balance to local state`);
        
        // Update local balance with server value to ensure consistency
        setBalance(serverBalance);
        
        // Update localStorage user data with new balance
        try {
          const savedUser = sessionStorage.getItem('betnexa_user') || localStorage.getItem('betnexa_user');
          if (savedUser) {
            const user = JSON.parse(savedUser);
            user.accountBalance = serverBalance;
            user.totalWinnings = data.updatedUser.total_winnings || user.totalWinnings || 0;
            sessionStorage.setItem('betnexa_user', JSON.stringify(user));
            localStorage.setItem('betnexa_user', JSON.stringify(user));
            console.log(`   âœ… localStorage updated with new balance: KSH ${serverBalance}`);
          }
        } catch (e) {
          console.warn('   âš ï¸ Could not update localStorage:', e);
        }

        // Dispatch event for UserContext to refresh - this ensures all contexts are in sync
        window.dispatchEvent(new CustomEvent('balance_updated', {
          detail: {
            newBalance: serverBalance,
            totalWinnings: data.updatedUser.total_winnings
          }
        }));
        console.log(`   ðŸ“¢ Dispatched balance_updated event`);
        
        console.log(`   âœ… Synced main balance from server after status update. New balance: KSH ${serverBalance}`);
      }

      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('   âŒ Error syncing bet status to database:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  };

  const setBalanceHandler = (amount: number) => {
    if (amount >= 0) {
      setBalance(amount);
    }
  };

  const syncBalance = (newBalance: number) => {
    if (newBalance >= 0) {
      setBalance(newBalance);
    }
  };

  const fetchAllBets = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexanewbackend.vercel.app';
      const response = await fetch(`${apiUrl}/api/bets/admin/all?t=${Date.now()}`, {
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store'
      });

      const data = await response.json();
      if (data.success && data.bets) {
        // Transform database bets to PlacedBet format
        const transformedBets: PlacedBet[] = data.bets.map((bet: any) => ({
          id: bet.id,
          betId: bet.bet_id || bet.id?.substring(0, 8),
          user_id: bet.user_id,
          username: bet.users?.username || 'Unknown',
          phone_number: bet.users?.phone_number || '-',
          date: bet.created_at || 'Unknown',
          time: bet.created_at || '',
          stake: bet.stake || 0,
          potentialWin: bet.potential_win || 0,
          totalOdds: bet.total_odds || 0,
          selections: bet.bet_selections || [],
          status: (bet.status || 'Open').charAt(0).toUpperCase() + (bet.status || 'Open').slice(1).toLowerCase() as PlacedBet['status'],
          amountWon: bet.amount_won
        }));

        setBets(transformedBets);
        console.log(`âœ… Loaded ${transformedBets.length} bets from backend`);
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch (error) {
      console.error('âŒ Error fetching all bets:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  };

  return (
    <BetContext.Provider value={{ 
      bets, 
      addBet, 
      removeBet, 
      balance, 
      stakeableBalance,
      withdrawableBalance,
      deposit, 
      withdraw, 
      placeBet, 
      updateBetStatus, 
      setBalance: setBalanceHandler, 
      setStakeableBalance,
      setWithdrawableBalance,
      syncBalance, 
      setBets, 
      fetchAllBets 
    }}>
      {children}
    </BetContext.Provider>
  );
}

export function useBets() {
  const context = useContext(BetContext);
  if (context === undefined) {
    throw new Error("useBets must be used within a BetProvider");
  }
  return context;
}


