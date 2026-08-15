/**
 * Balance Sync Service
 * Keeps balance synchronized across all parts of the app by using server as source of truth
 */

interface BalanceSyncListener {
  (newBalance: number): void;
}

interface ActivationStatusListener {
  (activated: boolean, activationDate: string | null): void;
}

class BalanceSyncService {
  private listeners: Map<string, BalanceSyncListener[]> = new Map(); // userId -> listeners
  private activationListeners: Map<string, ActivationStatusListener[]> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private lastFetchedBalance: Map<string, number> = new Map();
  private lastFetchedActivation: Map<string, boolean> = new Map();
  private isSyncing = false;

  /**
   * Subscribe to balance changes for a specific user
   */
  subscribe(userId: string, callback: BalanceSyncListener): () => void {
    if (!this.listeners.has(userId)) {
      this.listeners.set(userId, []);
    }
    this.listeners.get(userId)!.push(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(userId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  /**
   * Notify all listeners of balance change
   */
  private notifyListeners(userId: string, newBalance: number) {
    const callbacks = this.listeners.get(userId);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(newBalance);
        } catch (error) {
          console.error('Error in balance sync listener:', error);
        }
      });
    }
  }

  /**
   * Subscribe to activation status changes
   */
  subscribeActivation(userId: string, callback: ActivationStatusListener): () => void {
    if (!this.activationListeners.has(userId)) {
      this.activationListeners.set(userId, []);
    }
    this.activationListeners.get(userId)!.push(callback);
    return () => {
      const callbacks = this.activationListeners.get(userId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);
      }
    };
  }

  private notifyActivationListeners(userId: string, activated: boolean, activationDate: string | null) {
    const callbacks = this.activationListeners.get(userId);
    if (callbacks) {
      callbacks.forEach(cb => {
        try { cb(activated, activationDate); } catch (e) { console.error('Activation listener error:', e); }
      });
    }
  }

  /**
   * Fetch user's current balance from server
   */
  async fetchBalance(userId: string): Promise<number | null> {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexanewbackend.vercel.app';
      const response = await fetch(
        `${apiUrl}/api/payments/user-balance/${userId}`
      );
      const data = await response.json();

      if (data.success && data.balance !== null) {
        const balance = parseFloat(data.balance);
        this.lastFetchedBalance.set(userId, balance);

        // Update stakeable/withdrawable in localStorage for BetContext to pick up
        if (data.stakeable_balance !== undefined || data.withdrawable_balance !== undefined) {
          const stakeableBalance = parseFloat(data.stakeable_balance) || balance;
          const withdrawableBalance = parseFloat(data.withdrawable_balance) || 0;
          window.dispatchEvent(new CustomEvent('split_balance_updated', {
            detail: { userId, stakeableBalance, withdrawableBalance, accountBalance: balance }
          }));
        }

        // Track activation status changes
        const activated = data.withdrawalActivated || false;
        const prevActivated = this.lastFetchedActivation.get(userId);
        if (prevActivated === undefined || prevActivated !== activated) {
          this.lastFetchedActivation.set(userId, activated);
          this.notifyActivationListeners(userId, activated, data.withdrawalActivationDate || null);
        }

        return balance;
      }
      return null;
    } catch (error) {
      console.error('Failed to fetch balance from server:', error);
      return null;
    }
  }

  /**
   * Sync balance from server and notify listeners if changed
   */
  async sync(userId: string): Promise<number | null> {
    if (this.isSyncing) return null;

    this.isSyncing = true;
    try {
      const newBalance = await this.fetchBalance(userId);
      if (newBalance !== null) {
        const lastBalance = this.lastFetchedBalance.get(userId);
        if (lastBalance === undefined || newBalance !== lastBalance) {
          console.log(`ðŸ’° Balance synced for ${userId}: ${newBalance}`);
          this.notifyListeners(userId, newBalance);
        }
      }
      return newBalance;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Start automatic balance sync polling
   */
  startAutoSync(userId: string, intervalMs: number = 5000): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    console.log(`ðŸ”„ Starting auto-sync for ${userId} every ${intervalMs}ms`);
    
    // Initial sync
    this.sync(userId);

    // Then set up interval
    this.syncInterval = setInterval(() => {
      this.sync(userId).catch(err => console.warn('Auto-sync error:', err));
    }, intervalMs);
  }

  /**
   * Stop automatic balance sync
   */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('ðŸ›‘ Auto-sync stopped');
    }
  }

  /**
   * Get the last fetched balance for a user
   */
  getLastBalance(userId: string): number | null {
    return this.lastFetchedBalance.get(userId) || null;
  }

  /**
   * Update balance locally (for optimistic updates)
   */
  updateLocal(userId: string, newBalance: number): void {
    this.lastFetchedBalance.set(userId, newBalance);
    this.notifyListeners(userId, newBalance);
  }

  /**
   * Clear all data
   */
  destroy(): void {
    this.stopAutoSync();
    this.listeners.clear();
    this.activationListeners.clear();
    this.lastFetchedBalance.clear();
    this.lastFetchedActivation.clear();
  }
}

// Create singleton instance
const balanceSyncService = new BalanceSyncService();

export default balanceSyncService;


