import { createContext, useContext, useState, ReactNode, useEffect } from "react";

export interface Transaction {
  id: string;
  userId: string;
  username: string;
  type: "deposit" | "withdrawal" | "bet_placement" | "bet_payout" | "admin_adjustment";
  amount: number;
  status: "completed" | "pending" | "failed" | "cancelled";
  method: string;
  date: string;
  mpesaNumber?: string;
  mpesaReceipt?: string;
  externalReference?: string;
  adminNotes?: string;
  completedAt?: string;
}

export interface ActivationFee {
  id: string;
  user_id: string;
  fee_type: 'activation' | 'priority';
  amount: number;
  phone_number?: string;
  status: string;
  method?: string;
  created_at: string;
}

interface TransactionContextType {
  transactions: Transaction[];
  activationFees: ActivationFee[];
  addTransaction: (transaction: Transaction) => Promise<void>;
  updateTransactionStatus: (transactionId: string, status: Transaction["status"], phone?: string) => Promise<void>;
  getUserTransactions: (userId: string) => Transaction[];
  getUserActivationFees: (userId: string) => ActivationFee[];
  getAllTransactions: () => Transaction[];
  fetchTransactions: (userId: string) => Promise<void>;
  isLoading: boolean;
}

const TransactionContext = createContext<TransactionContextType | undefined>(undefined);

export function TransactionProvider({ children }: { children: ReactNode }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [activationFees, setActivationFees] = useState<ActivationFee[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch transactions from server for a specific user
  const fetchTransactions = async (userId: string) => {
    try {
      setIsLoading(true);
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/transactions/user/${userId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        console.warn('âš ï¸ Failed to fetch transactions from server');
        return;
      }

      const data = await response.json();
      if (data.success && data.transactions) {
        // Transform server transactions to match frontend format
        const transformedTransactions = data.transactions.map((tx: any) => ({
          // UI should treat all non-completed terminal outcomes as failed.
          status: tx.status === 'cancelled' ? 'failed' : tx.status,
          id: tx.id,
          userId: tx.user_id,
          username: data.user?.username || 'User',
          type: tx.type,
          amount: tx.amount,
          method: tx.method || 'M-Pesa',
          date: new Date(tx.created_at).toLocaleString(),
          mpesaReceipt: tx.mpesa_receipt,
          externalReference: tx.external_reference,
          adminNotes: tx.admin_notes,
          completedAt: tx.completed_at
        }));

        setTransactions(transformedTransactions);
        console.log(`âœ… Fetched ${transformedTransactions.length} transactions from server for user ${userId}`);

        // Store activation fees if returned
        if (data.activation_fees) {
          setActivationFees(data.activation_fees);
          console.log(`âœ… Fetched ${data.activation_fees.length} activation fees`);
        }
      }
    } catch (error) {
      console.error('âŒ Error fetching transactions:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const addTransaction = async (transaction: Transaction) => {
    // Add to local state immediately for UI feedback
    setTransactions((prev) => [transaction, ...prev]);
    
    // Optionally sync to database (transactions are already created by payment endpoint)
    console.log('ðŸ“Š Transaction added locally:', transaction.id);
  };

  const updateTransactionStatus = async (
    transactionId: string,
    status: Transaction["status"],
    phone?: string
  ) => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const endpoint = status === 'failed'
        ? `${apiUrl}/api/admin/transactions/${transactionId}/mark-rejected`
        : status === 'pending'
        ? `${apiUrl}/api/admin/transactions/${transactionId}/mark-pending`
        : `${apiUrl}/api/admin/transactions/${transactionId}/mark-completed`;

      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone || '' })
      });

      const data = await response.json();
      if (data.success) {
        // Update local state to reflect the change immediately
        setTransactions((prev) =>
          prev.map((t) => (t.id === transactionId ? { ...t, status } : t))
        );
        console.log(`âœ… Transaction ${transactionId} marked as ${status} on server`);
      } else {
        console.error('âŒ Failed to update transaction status:', data.message);
        throw new Error(data.message);
      }
    } catch (error) {
      console.error('âŒ Error updating transaction status:', error);
      throw error;
    }
  };

  const getUserTransactions = (userId: string) => {
    return transactions.filter((t) => t.userId === userId);
  };

  const getUserActivationFees = (userId: string) => {
    return activationFees.filter((f) => f.user_id === userId);
  };

  const getAllTransactions = () => {
    return transactions;
  };

  return (
    <TransactionContext.Provider
      value={{
        transactions,
        activationFees,
        addTransaction,
        updateTransactionStatus,
        getUserTransactions,
        getUserActivationFees,
        getAllTransactions,
        fetchTransactions,
        isLoading
      }}
    >
      {children}
    </TransactionContext.Provider>
  );
}

export function useTransactions() {
  const context = useContext(TransactionContext);
  if (context === undefined) {
    throw new Error("useTransactions must be used within a TransactionProvider");
  }
  return context;
}
