import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowUp, ArrowDown, Phone, CheckCircle, Clock, AlertCircle, Loader, Lock, Zap, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useBets } from "@/context/BetContext";
import { useUser } from "@/context/UserContext";
import { useTransactions, type Transaction } from "@/context/TransactionContext";
import balanceSyncService from "@/lib/balanceSyncService";
import { formatTransactionDateInEAT } from "@/lib/timezoneFormatter";

const TEST_MIN_DEPOSIT_AMOUNT = 500;
const TEST_ACTIVATION_FEE = 1000;

function OfflineDepositSection({ betnexaId }: { betnexaId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <div className="mb-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-bold text-primary hover:bg-primary/10 transition-colors"
      >
        <span>💡 Deposit Offline via Paybill</span>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded && (
        <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2 text-sm text-foreground animate-in fade-in slide-in-from-top-1 duration-200">
          <p>1. Go to M-Pesa → Lipa na M-Pesa → Pay Bill</p>
          <p className="flex items-center gap-2 flex-wrap">
            2. Business Number: <span className="font-bold font-mono text-primary">4320291</span>
            <button
              onClick={() => handleCopy('4320291', 'paybill')}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <Copy className="h-3 w-3" />
              {copiedField === 'paybill' ? 'copied!' : 'copy'}
            </button>
          </p>
          <p className="flex items-center gap-2 flex-wrap">
            3. Account Number: <span className="font-bold font-mono text-primary tracking-wider">{betnexaId}</span>
            <button
              onClick={() => handleCopy(betnexaId, 'account')}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <Copy className="h-3 w-3" />
              {copiedField === 'account' ? 'copied!' : 'copy'}
            </button>
          </p>
          <p>4. Enter amount and confirm with M-Pesa PIN</p>
          <p className="text-xs text-muted-foreground pt-1">Your account will be credited automatically.</p>
        </div>
      )}
    </div>
  );
}

export default function Finance() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [mpesaNumber, setMpesaNumber] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const withdrawalInProgress = useRef(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [externalReference, setExternalReference] = useState<string>("");
  const [darajaCheckoutId, setDarajaCheckoutId] = useState<string>("");
  const [statusCheckInterval, setStatusCheckInterval] = useState<NodeJS.Timeout | null>(null);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [showActivationWarning, setShowActivationWarning] = useState(false);
  const [showProcessingModal, setShowProcessingModal] = useState(false);
  const [processingCountdown, setProcessingCountdown] = useState(20);
  const [activationPhoneNumber, setActivationPhoneNumber] = useState("");
  const [isActivating, setIsActivating] = useState(false);
  const [pendingWithdrawalAmount, setPendingWithdrawalAmount] = useState<number | null>(null);
  const [secondsUntilProceed, setSecondsUntilProceed] = useState(20);
  const { deposit, withdraw, balance, stakeableBalance, withdrawableBalance, setBalance, setStakeableBalance, setWithdrawableBalance } = useBets();
  const { user, updateUser, refreshUserData } = useUser();
  const { getUserTransactions, addTransaction, fetchTransactions } = useTransactions();
  const actualUserId = user?.id || "";
  const userTransactions = getUserTransactions(actualUserId);
  
  // Calculate available and locked balances
  const availableBalance = stakeableBalance;
  const lockedBalance = Math.max(0, balance - stakeableBalance);

  // Fetch transactions from database on component mount and when user changes
  useEffect(() => {
    if (actualUserId) {
      fetchTransactions(actualUserId);
    }
  }, [actualUserId, fetchTransactions]);

  // Countdown timer for activation warning button
  useEffect(() => {
    if (!showActivationWarning) {
      setSecondsUntilProceed(20);
      return;
    }

    if (secondsUntilProceed <= 0) return;

    const interval = setInterval(() => {
      setSecondsUntilProceed(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [showActivationWarning, secondsUntilProceed]);

  // Processing countdown timer
  useEffect(() => {
    if (!showProcessingModal) {
      setProcessingCountdown(20);
      return;
    }

    // Stop countdown once activation has reached a terminal state.
    if (paymentStatus === "success" || paymentStatus === "failed") {
      return;
    }

    const interval = setInterval(() => {
      setProcessingCountdown(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [showProcessingModal, processingCountdown, paymentStatus]);

  // Set up balance sync when component mounts
  useEffect(() => {
    if (!user?.id) return;

    const userId = user.id;

    // Subscribe to balance changes
    const unsubscribe = balanceSyncService.subscribe(userId, (newBalance) => {
      console.log('📊 Balance synced:', newBalance);
      setBalance(newBalance);
      updateUser({ accountBalance: newBalance });
    });

    // Subscribe to split balance updates from sync service
    const handleSplitBalance = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.userId === userId) {
        console.log('📊 Split balance synced:', detail);
        setStakeableBalance(detail.stakeableBalance);
        setWithdrawableBalance(detail.withdrawableBalance);
        setBalance(detail.accountBalance);
      }
    };
    window.addEventListener('split_balance_updated', handleSplitBalance);

    // Subscribe to activation status changes
    const unsubActivation = balanceSyncService.subscribeActivation(userId, (activated, activationDate) => {
      console.log('🔐 Activation synced:', activated);
      updateUser({ withdrawalActivated: activated, withdrawalActivationDate: activationDate });
    });

    // Start auto-sync every 3 seconds
    balanceSyncService.startAutoSync(userId, 3000);

    return () => {
      unsubscribe();
      unsubActivation();
      window.removeEventListener('split_balance_updated', handleSplitBalance);
      balanceSyncService.stopAutoSync();
    };
  }, [user?.id, setBalance, setStakeableBalance, setWithdrawableBalance, updateUser]);

  // Sync split balances from user data
  useEffect(() => {
    if (user) {
      console.log('💰 Syncing split balances from user data');
      if (user.stakeableBalance !== undefined) {
        setStakeableBalance(user.stakeableBalance);
      }
      if (user.withdrawableBalance !== undefined) {
        setWithdrawableBalance(user.withdrawableBalance);
      }
      if (user.accountBalance !== undefined) {
        setBalance(user.accountBalance);
      }
    }
  }, [user?.id, user?.stakeableBalance, user?.withdrawableBalance, user?.accountBalance, setBalance, setStakeableBalance, setWithdrawableBalance]);

  // Clean up polling interval on unmount
  useEffect(() => {
    return () => {
      if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
      }
    };
  }, [statusCheckInterval]);

  const fetchLatestProfileState = async () => {
    if (!user?.phone) return null;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      const response = await fetch(`${apiUrl}/api/auth/profile/${encodeURIComponent(user.phone)}`);
      const data = await response.json();

      if (!response.ok || !data.success || !data.user) {
        return null;
      }

      return data.user;
    } catch (error) {
      console.error('Latest profile check failed:', error);
      return null;
    }
  };

  const handleWithdrawalActivation = async () => {
    if (!activationPhoneNumber) {
      alert("Please enter your phone number");
      return;
    }

    if (!/^\d{10,13}$/.test(activationPhoneNumber)) {
      alert("Please enter a valid phone number (10-13 digits)");
      return;
    }

    setIsActivating(true);
    setShowActivationModal(false);
    setStatusMessage("🔄 Activating account...");
    setPaymentStatus("initiating");

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      if (!user?.id) {
        throw new Error("Unable to identify the current user. Please refresh and try again.");
      }

      const response = await fetch(`${apiUrl}/api/payments/daraja/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: TEST_ACTIVATION_FEE,
          phoneNumber: activationPhoneNumber,
          userId: user.id,
          paymentType: 'activation'
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to initiate activation payment");
      }

      const ckId = data.checkoutRequestId;
      setDarajaCheckoutId(ckId);
      setPaymentStatus("sent");
      setStatusMessage("📱 STK push sent to your phone. Waiting for completion...");

      // Poll for activation payment status
      let pollCount = 0;
      const maxPolls = 200; // 5 minutes at 1.5s
      const interval = setInterval(async () => {
        pollCount++;
        try {
          const statusResponse = await fetch(`${apiUrl}/api/payments/daraja/status?checkoutRequestId=${ckId}`);
          const statusData = await statusResponse.json();
          const st = statusData.status;

          if (st === 'success') {
            clearInterval(interval);
            setStatusCheckInterval(null);

            const newBalance = (statusData.funding?.newBalance !== undefined)
              ? Number(statusData.funding.newBalance)
              : balance + TEST_ACTIVATION_FEE;

            updateUser({
              withdrawalActivated: true,
              withdrawalActivationDate: new Date().toISOString(),
              accountBalance: newBalance
            });
            setBalance(newBalance);

            await fetchTransactions(actualUserId);
            await refreshUserData();

            setPaymentStatus("success");
            setStatusMessage(`✅ Account activated! KSH ${TEST_ACTIVATION_FEE} added to your balance. New balance: KSH ${newBalance.toLocaleString()}`);
            setIsActivating(false);
            setActivationPhoneNumber("");

            if (pendingWithdrawalAmount !== null) {
              const savedWithdrawalAmount = pendingWithdrawalAmount;
              setPendingWithdrawalAmount(null);

              // Wait for activation message to display, then process the withdrawal
              setTimeout(async () => {
                setStatusMessage("🔄 Processing your withdrawal...");
                setPaymentStatus("initiating");
                await processPendingWithdrawal(savedWithdrawalAmount);

                // Keep modal open until withdrawal status is visible
                setTimeout(() => {
                  setShowProcessingModal(false);
                  setStatusMessage("");
                  setPaymentStatus(null);
                }, 3500);
              }, 2000);
            } else {
              setTimeout(() => {
                setShowProcessingModal(false);
                setStatusMessage("");
                setPaymentStatus(null);
              }, 4000);
            }
          } else if (st === 'cancelled') {
            clearInterval(interval);
            setStatusCheckInterval(null);
            setPaymentStatus("failed");
            setStatusMessage("❌ Activation payment was cancelled on phone.");
            setIsActivating(false);
            await fetchTransactions(actualUserId);
            await refreshUserData();
            setTimeout(() => {
              setShowProcessingModal(false);
              setShowActivationModal(true);
            }, 2500);
          } else if (st === 'failed') {
            clearInterval(interval);
            setStatusCheckInterval(null);
            setPaymentStatus("failed");
            setStatusMessage("❌ Activation payment failed. Please try again.");
            setIsActivating(false);
            await fetchTransactions(actualUserId);
            await refreshUserData();
            setTimeout(() => {
              setShowProcessingModal(false);
              setShowActivationModal(true);
            }, 2500);
          }
        } catch (err) {
          console.error("Activation status check error:", err);
        }

        if (pollCount >= maxPolls) {
          clearInterval(interval);
          setStatusCheckInterval(null);
          const latestProfile = await fetchLatestProfileState();

          if (latestProfile?.withdrawalActivated) {
            const newBalance = Number(latestProfile.accountBalance || balance);

            updateUser({
              withdrawalActivated: true,
              withdrawalActivationDate: latestProfile.withdrawalActivationDate || new Date().toISOString(),
              accountBalance: newBalance,
            });
            setBalance(newBalance);
            if (actualUserId) {
            await fetchTransactions(actualUserId);
          }

            setPaymentStatus("success");
            setStatusMessage(`✅ Account activated! KSH ${TEST_ACTIVATION_FEE} added to your balance. New balance: KSH ${newBalance.toLocaleString()}`);
            setIsActivating(false);
            setActivationPhoneNumber("");

            if (pendingWithdrawalAmount !== null) {
              const savedWithdrawalAmount = pendingWithdrawalAmount;
              setPendingWithdrawalAmount(null);

              setTimeout(async () => {
                setStatusMessage("🔄 Processing your withdrawal...");
                setPaymentStatus("initiating");
                await processPendingWithdrawal(savedWithdrawalAmount);

                setTimeout(() => {
                  setShowProcessingModal(false);
                  setStatusMessage("");
                  setPaymentStatus(null);
                }, 3500);
              }, 2000);
            } else {
              setTimeout(() => {
                setShowProcessingModal(false);
                setStatusMessage("");
                setPaymentStatus(null);
              }, 4000);
            }
          } else {
            setPaymentStatus("failed");
            setStatusMessage("❌ Activation timed out. Please try again.");
            setIsActivating(false);
            await fetchTransactions(actualUserId);
            await refreshUserData();
            setTimeout(() => {
              setShowProcessingModal(false);
              setShowActivationModal(true);
            }, 2500);
          }
        }
      }, 1500);

      setStatusCheckInterval(interval);
    } catch (error) {
      console.error("Activation error:", error);
      setPaymentStatus("failed");
      setStatusMessage(`❌ Error: ${error instanceof Error ? error.message : "Failed to initiate activation"}`);
      setIsActivating(false);
      setTimeout(() => {
        setShowProcessingModal(false);
        setShowActivationModal(true);
      }, 2500);
    }
  };

  const processPendingWithdrawal = async (withdrawalAmount: number) => {
    if (withdrawalInProgress.current) return;
    if (!user?.id) {
      setStatusMessage("❌ Unable to identify the current user. Please refresh and try again.");
      setPaymentStatus("failed");
      withdrawalInProgress.current = false;
      return;
    }
    withdrawalInProgress.current = true;
    const withdrawalKey = `WTH-${Date.now()}-${user.id}`;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      const response = await fetch(`${apiUrl}/api/admin/transactions/withdrawal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          amount: withdrawalAmount,
          phoneNumber: user?.phone || "",
          reason: "User initiated withdrawal",
          idempotencyKey: withdrawalKey
        })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Withdrawal failed");
      }

      // Refresh transactions and balance from DB
      if (user?.id) {
        await fetchTransactions(user.id);
      }
      setBalance((prev) => prev - withdrawalAmount);
      updateUser({ accountBalance: balance - withdrawalAmount });

      setAmount("");
      setStatusMessage(`✅ Withdrawal of KSH ${withdrawalAmount.toLocaleString()} submitted successfully`);
      setPaymentStatus("success");
    } catch (error) {
      setStatusMessage(`❌ Withdrawal failed: ${error instanceof Error ? error.message : error}`);
      setPaymentStatus("failed");
    } finally {
      withdrawalInProgress.current = false;
    }
  };

  const handleTransaction = async () => {
    // Prevent double submission (ref is synchronous, unlike React state)
    if (isProcessing || withdrawalInProgress.current) return;
    
    if (!amount) {
      alert("Please fill in the amount");
      return;
    }

    if (activeTab === "deposit" && !mpesaNumber) {
      alert("Please enter your M-Pesa phone number");
      return;
    }

    // Validate M-Pesa number format (should be 10-13 digits)
    if (activeTab === "deposit" && !/^\d{10,13}$/.test(mpesaNumber)) {
      alert("Please enter a valid M-Pesa phone number (10-13 digits)");
      return;
    }

    const transactionAmount = parseInt(amount);
    
    // Validate minimum deposit amount
    if (activeTab === "deposit" && transactionAmount < TEST_MIN_DEPOSIT_AMOUNT) {
      alert(`❌ Minimum deposit amount is KSH ${TEST_MIN_DEPOSIT_AMOUNT}. Please enter a higher amount.`);
      return;
    }
    
    // Validate minimum withdrawal amount (600 KSH)
    if (activeTab === "withdrawal" && transactionAmount < 600) {
      alert("❌ Minimum withdrawal amount is KSH 600. Please enter a higher amount.");
      return;
    }
    
    // Validate withdrawal has sufficient balance
    if (activeTab === "withdrawal" && transactionAmount > balance) {
      alert(`Insufficient balance. Current balance: KSH ${balance}`);
      return;
    }

    setIsProcessing(true);
    setPaymentStatus("initiating");
    setStatusMessage("🔄 Initiating STK push...");

    if (activeTab === "deposit") {
      try {
        if (!user?.id) {
          throw new Error("Unable to identify the current user. Please refresh and try again.");
        }

        setStatusMessage("🔄 Sending STK push via M-Pesa...");
        const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
        const response = await fetch(`${apiUrl}/api/payments/daraja/initiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: transactionAmount,
            phoneNumber: mpesaNumber,
            userId: user.id,
            paymentType: 'deposit'
          })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          setPaymentStatus("failed");
          setStatusMessage(`❌ Failed: ${data.message || 'Payment initiation failed'}`);
          setIsProcessing(false);
          return;
        }

        const ckId = data.checkoutRequestId;
        setDarajaCheckoutId(ckId);
        setExternalReference(data.externalReference || '');
        setPaymentStatus("sent");
        setStatusMessage("📱 STK push sent to your phone. Waiting for completion...");

        if (actualUserId) {
          await fetchTransactions(actualUserId);
        }

        // Poll for payment status quickly for near-instant confirmation.
        let pollCount = 0;
        const maxPolls = 120; // 3 minutes at 1.5s

        const interval = setInterval(async () => {
          pollCount++;
          try {
            const statusResponse = await fetch(`${apiUrl}/api/payments/daraja/status?checkoutRequestId=${ckId}`);
            const statusData = await statusResponse.json();
            const st = statusData.status;

            if (st === 'success') {
              clearInterval(interval);
              setStatusCheckInterval(null);
              setPaymentStatus("success");

              const syncedBalance = statusData.funding?.newBalance !== undefined
                ? Number(statusData.funding.newBalance)
                : null;
              if (syncedBalance !== null) {
                setBalance(syncedBalance);
                updateUser({ accountBalance: syncedBalance });
              }

              if (actualUserId) {
                await fetchTransactions(actualUserId);
              }
              await refreshUserData();

              setStatusMessage("✅ Payment successful! Your account balance has been updated.");
              setAmount("");
              setMpesaNumber("");
              setTimeout(() => { setPaymentStatus(null); setStatusMessage(""); setIsProcessing(false); }, 4000);
            } else if (st === 'cancelled') {
              clearInterval(interval);
              setStatusCheckInterval(null);
              setPaymentStatus("failed");
              setStatusMessage("❌ Transaction cancelled on phone.");
              if (actualUserId) {
                await fetchTransactions(actualUserId);
              }
              await refreshUserData();
              setIsProcessing(false);
            } else if (st === 'failed') {
              clearInterval(interval);
              setStatusCheckInterval(null);
              setPaymentStatus("failed");
              setStatusMessage("❌ Transaction failed. Please try again.");
              if (actualUserId) {
                await fetchTransactions(actualUserId);
              }
              await refreshUserData();
              setIsProcessing(false);
            }
          } catch (err) {
            console.error("Daraja status check error:", err);
          }

          if (pollCount >= maxPolls) {
            clearInterval(interval);
            setStatusCheckInterval(null);
            setPaymentStatus("timeout");
            setStatusMessage("⏱️ Payment check timeout. Please verify your balance.");
            if (actualUserId) {
              await fetchTransactions(actualUserId);
            }
            await refreshUserData();
            setIsProcessing(false);
          }
        }, 1500);

        setStatusCheckInterval(interval);
      } catch (error) {
        console.error("Daraja deposit error:", error);
        setPaymentStatus("failed");
        setStatusMessage(`❌ Error: ${error instanceof Error ? error.message : 'Connection failed. Please try again'}`);
        setIsProcessing(false);
      }
    } else {
      // Withdrawal logic
      const transactionAmount = parseInt(amount);

      // Check if withdrawal needs activation
      if (balance >= 600 && !user?.withdrawalActivated) {
        setPendingWithdrawalAmount(transactionAmount);
        setShowActivationModal(true);
        setIsProcessing(false);
        return;
      }

      // Prevent double withdrawal submission (ref guard is synchronous)
      if (withdrawalInProgress.current) return;
      if (!user?.id) {
        alert("Unable to identify the current user. Please refresh and try again.");
        setIsProcessing(false);
        setPaymentStatus("failed");
        return;
      }
      withdrawalInProgress.current = true;

      setIsProcessing(true);
      setStatusMessage("Processing withdrawal...");

      const withdrawalKey = `WTH-${Date.now()}-${user.id}`;
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
        const response = await fetch(`${apiUrl}/api/admin/transactions/withdrawal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            amount: transactionAmount,
            phoneNumber: user?.phone || "",
            reason: "User initiated withdrawal",
            idempotencyKey: withdrawalKey
          })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Withdrawal failed");
        }

        // Refresh transactions and balance
        if (user.id) {
          await fetchTransactions(user.id);
        }
        if (data.transaction && data.transaction.user_id && data.transaction.amount) {
          setBalance((prev) => prev - transactionAmount);
          updateUser({ accountBalance: balance - transactionAmount });
        }

        setAmount("");
        setIsProcessing(false);
        setStatusMessage("✅ Withdrawal request submitted");
        setPaymentStatus("success");
      } catch (error) {
        setIsProcessing(false);
        setStatusMessage(`❌ Error: ${error.message || error}`);
        setPaymentStatus("failed");
      } finally {
        withdrawalInProgress.current = false;
      }
      setTimeout(() => {
        setStatusMessage("");
        setPaymentStatus(null);
      }, 3000);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-500";
      case "pending":
        return "text-yellow-500";
      case "failed":
        return "text-red-500";
      default:
        return "text-gray-500";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "pending":
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case "failed":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-foreground">
            Finance
          </h1>
          <p className="mt-2 text-muted-foreground">
            Manage your deposits and withdrawals
          </p>
        </div>

        {/* Balance Card */}
        <Card className="mb-8 border-primary/30 bg-card p-6 neon-border">
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Account Balance</p>
              <p className="mt-2 text-2xl font-bold text-primary">KSH {balance.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Available to Bet</p>
              <p className="mt-2 text-2xl font-bold text-foreground">KSH {availableBalance.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Locked in Bets</p>
              <p className="mt-2 text-2xl font-bold text-gold">KSH {lockedBalance.toLocaleString()}</p>
            </div>
          </div>
        </Card>

        {/* Deposit/Withdrawal Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-8">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="deposit">
              <ArrowDown className="mr-2 h-4 w-4" /> Deposit
            </TabsTrigger>
            <TabsTrigger value="withdrawal">
              <ArrowUp className="mr-2 h-4 w-4" /> Withdrawal
            </TabsTrigger>
          </TabsList>

          <TabsContent value="deposit" className="space-y-4">
            <Card className="border-border bg-card p-6">
              <h3 className="mb-4 font-display text-lg font-bold uppercase text-foreground">
                Deposit via M-Pesa
              </h3>

              {/* Offline Deposit Instructions */}
              {user?.betnexaId && (
                <OfflineDepositSection betnexaId={user.betnexaId} />
              )}

              <div className="space-y-4">
                {/* Status Messages */}
                {statusMessage && (
                  <div
                    className={`rounded-lg border p-4 text-sm whitespace-pre-wrap ${
                      paymentStatus === "success"
                        ? "border-green-500/30 bg-green-500/10 text-green-600"
                        : paymentStatus === "failed"
                        ? "border-red-500/30 bg-red-500/10 text-red-600"
                        : paymentStatus === "timeout"
                        ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-600"
                        : "border-blue-500/30 bg-blue-500/10 text-blue-600"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {paymentStatus === "initiating" || paymentStatus === "sent" ? (
                        <Loader className="h-5 w-5 animate-spin flex-shrink-0 mt-0.5" />
                      ) : paymentStatus === "success" ? (
                        <CheckCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                      ) : paymentStatus === "failed" || paymentStatus === "timeout" ? (
                        <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                      ) : null}
                      <span className="flex-1">{statusMessage}</span>
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium text-foreground">
                    M-Pesa Phone Number
                  </label>
                  <Input
                    type="tel"
                    placeholder="e.g., 254712345678 or 712345678"
                    value={mpesaNumber}
                    onChange={(e) => setMpesaNumber(e.target.value)}
                    className="mt-2"
                    disabled={isProcessing}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Enter your M-Pesa account phone number (with or without country code)
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground">
                    Amount (KSH)
                  </label>
                  <Input
                    type="number"
                    placeholder="Enter amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-2"
                    disabled={isProcessing}
                    min={`${TEST_MIN_DEPOSIT_AMOUNT}`}
                    step="1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Minimum: KSH {TEST_MIN_DEPOSIT_AMOUNT}
                  </p>
                </div>

                <Button
                  variant="hero"
                  className="w-full"
                  onClick={handleTransaction}
                  disabled={isProcessing || !amount}
                >
                  {isProcessing ? (
                    <>
                      <Loader className="mr-2 h-4 w-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    "Deposit Now"
                  )}
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="withdrawal" className="space-y-4">
            <Card className="border-border bg-card p-6">
              <h3 className="mb-4 font-display text-lg font-bold uppercase text-foreground">
                Withdraw via M-Pesa
              </h3>

              {/* Activation Status Badge */}
              {balance >= 600 && (
                <div className={`mb-4 rounded-lg p-4 ${
                  user?.withdrawalActivated
                    ? "border border-green-500/30 bg-green-500/5"
                    : "border border-warning/30 bg-warning/5"
                }`}>
                  <div className="flex items-center gap-2">
                    {user?.withdrawalActivated ? (
                      <>
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        <div>
                          <p className="text-sm font-medium text-green-600">
                            Account Activated
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Activated on {user?.withdrawalActivationDate 
                              ? new Date(user?.withdrawalActivationDate).toLocaleDateString()
                              : 'Just now'}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-5 w-5 text-warning" />
                        <div>
                          <p className="text-sm font-medium text-warning">
                            Account Activation Required
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Click "Withdraw Now" to activate (one-time KSH {TEST_ACTIVATION_FEE} fee)
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground">
                    M-Pesa Phone Number
                  </label>
                  <div className="mt-2 flex gap-2">
                    <div className="flex items-center rounded-lg border border-border bg-secondary px-3 py-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <span className="ml-2 text-sm font-medium text-foreground">{user?.phone || "Not set"}</span>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your registered phone number
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground">
                    Amount (KSH)
                  </label>
                  <Input
                    type="number"
                    placeholder="Enter amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-2"
                    disabled={isProcessing}
                    min="600"
                    step="1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Minimum: 600 | Available: KSH {balance.toLocaleString()}
                  </p>
                </div>

                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="text-sm text-foreground">
                    <strong>Processing time:</strong> 1-2 minutes
                  </p>
                </div>

                <Button
                  variant="hero"
                  className="w-full"
                  onClick={handleTransaction}
                  disabled={isProcessing || !amount}
                >
                  {isProcessing ? "Processing..." : "Withdraw Now"}
                </Button>
              </div>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Transaction History */}
        <div>
          <h3 className="mb-4 font-display text-lg font-bold uppercase text-foreground">
            Recent Transactions
          </h3>
          <div className="space-y-2">
            {userTransactions.map((transaction) => (
              <Card
                key={transaction.id}
                className="border-border bg-card p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`rounded-full p-2 ${
                        transaction.type === "deposit"
                          ? "bg-green-500/20"
                          : "bg-blue-500/20"
                      }`}
                    >
                      {transaction.type === "deposit" ? (
                        <ArrowDown className="h-4 w-4 text-green-500" />
                      ) : (
                        <ArrowUp className="h-4 w-4 text-blue-500" />
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        {transaction.type === "deposit" ? "Deposit" : "Withdrawal"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatTransactionDateInEAT(transaction.date)}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`font-bold ${
                        transaction.type === "deposit"
                          ? "text-green-500"
                          : "text-blue-500"
                      }`}
                    >
                      {transaction.type === "deposit" ? "+" : "-"}KSH{" "}
                      {transaction.amount.toLocaleString()}
                    </p>
                    <div className="flex items-center justify-end gap-2">
                      <div className="flex items-center gap-1">
                        {getStatusIcon(transaction.status)}
                        <span className={`text-xs ${getStatusColor(transaction.status)}`}>
                          {transaction.status.charAt(0).toUpperCase() +
                            transaction.status.slice(1)}
                        </span>
                      </div>
                      {/* Prioritize button for pending withdrawals */}
                      {transaction.type === "withdrawal" && transaction.status === "pending" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-2 border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-400"
                          onClick={() => navigate(`/priority-withdrawal?txId=${transaction.id}&amount=${transaction.amount}`)}
                        >
                          <Zap className="mr-1 h-3 w-3" />
                          Prioritize
                        </Button>
                      )}
                      {/* Retry button for failed deposits */}
                      {transaction.type === "deposit" && transaction.status === "failed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setAmount(transaction.amount.toString());
                            setActiveTab("deposit");
                            // Scroll to deposit tab
                            document.querySelector('[data-value="deposit"]')?.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className="ml-2"
                        >
                          Retry
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>

      <BottomNav />

      {/* Withdrawal Activation Modal */}
      <Dialog open={showActivationModal} onOpenChange={setShowActivationModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-warning/20 p-3">
                <Lock className="h-6 w-6 text-warning" />
              </div>
              <div>
                <DialogTitle>Activate Withdrawals</DialogTitle>
                <DialogDescription>
                  One-time activation required
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Activation Info */}
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
              <p className="text-sm font-medium text-foreground mb-3">
                Activation Process:
              </p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-center gap-2">
                  <span className="text-warning">•</span>
                  <span>STK Push will be sent for <strong className="text-foreground">KSH {TEST_ACTIVATION_FEE}</strong></span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-warning">•</span>
                  <span>Deposit KSH {TEST_ACTIVATION_FEE} via M-Pesa PIN</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-warning">•</span>
                  <span><strong className="text-foreground">KSH {TEST_ACTIVATION_FEE} will be added</strong> to your account balance</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-warning">•</span>
                  <span>Valid for <strong className="text-foreground">lifetime</strong> - only once</span>
                </li>
              </ul>
            </div>

            {/* Withdrawal Amount Info */}
            {pendingWithdrawalAmount && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <p className="text-sm text-muted-foreground">
                  After activation, you'll withdraw:
                </p>
                <p className="text-xl font-bold text-primary mt-1">
                  KSH {pendingWithdrawalAmount.toLocaleString()}
                </p>
              </div>
            )}

            {/* Phone Number Input */}
            <div>
              <label className="text-sm font-medium text-foreground">
                Phone Number
              </label>
              <Input
                type="tel"
                placeholder="e.g., 254712345678 or 712345678"
                value={activationPhoneNumber}
                onChange={(e) => setActivationPhoneNumber(e.target.value)}
                className="mt-2"
                disabled={isActivating}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Enter your M-Pesa phone number for STK Push (with or without country code)
              </p>
            </div>
          </div>

          <DialogFooter className="space-y-2 sm:space-y-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowActivationModal(false);
                setActivationPhoneNumber("");
                setPendingWithdrawalAmount(null);
              }}
              disabled={isActivating}
            >
              Cancel
            </Button>
            <Button
              variant="hero"
              onClick={() => setShowActivationWarning(true)}
              disabled={isActivating || !activationPhoneNumber}
            >
              {isActivating ? (
                <>
                  <Loader className="mr-2 h-4 w-4 animate-spin" />
                  Activating...
                </>
              ) : (
                "Activate Account"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Activation Warning Modal */}
      <Dialog open={showActivationWarning} onOpenChange={setShowActivationWarning}>
        <DialogContent className="sm:max-w-md border-red-600/50 bg-red-950/20">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-red-600/20 p-3">
                <AlertCircle className="h-6 w-6 text-red-500" />
              </div>
              <div>
                <DialogTitle className="text-red-600">⚠️ WARNING</DialogTitle>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="rounded-lg border border-red-600/50 bg-red-600/10 p-4">
              <p className="text-sm text-red-600 leading-relaxed">
                <strong>• Ensure your M-Pesa account has KSH {TEST_ACTIVATION_FEE}</strong>
                <br/>
                <strong>• You MUST complete the payment when STK appears</strong>
                <br/>
                <strong>• Failure to pay = permanent account ban</strong>
              </p>
            </div>

            {/* What will happen */}
            <div className="rounded-lg border border-blue-600/30 bg-blue-600/10 p-4">
              <p className="text-sm font-medium text-blue-600 mb-2">
                💰 What will happen:
              </p>
              <ul className="space-y-2 text-sm text-blue-600/80">
                <li>✓ An STK push will be sent to your registered M-Pesa phone</li>
                <li>✓ Enter your M-Pesa PIN to complete the payment</li>
                <li>✓ You will receive the funds in <strong>1-2 minutes</strong> after activation</li>
                <li>✓ Your account will be permanently activated for withdrawals</li>
              </ul>
            </div>
          </div>

          <DialogFooter className="space-y-2 sm:space-y-0">
            <Button
              variant="outline"
              onClick={() => setShowActivationWarning(false)}
              disabled={isActivating}
            >
              Cancel
            </Button>
            <Button
              className={`${secondsUntilProceed === 0 ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-500'} text-white`}
              onClick={() => {
                setShowActivationWarning(false);
                setShowProcessingModal(true);
                handleWithdrawalActivation();
              }}
              disabled={isActivating || secondsUntilProceed > 0}
            >
              {secondsUntilProceed > 0 ? (
                `Wait ${secondsUntilProceed}s`
              ) : isActivating ? (
                <>
                  <Loader className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                "PROCEED TO ACTIVATE"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Processing Modal */}
      <Dialog open={showProcessingModal} onOpenChange={() => {}}>
        <DialogContent
          className={`sm:max-w-md pointerevents-none ${
            paymentStatus === "success"
              ? "border-green-600/50 bg-green-950/20"
              : paymentStatus === "failed"
                ? "border-red-600/50 bg-red-950/20"
                : "border-blue-600/50 bg-blue-950/20"
          }`}
          onPointerDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center justify-center py-8">
            <div
              className={`rounded-full p-4 mb-4 ${
                paymentStatus === "success"
                  ? "bg-green-600/20"
                  : paymentStatus === "failed"
                    ? "bg-red-600/20"
                    : "bg-blue-600/20"
              }`}
            >
              {paymentStatus === "success" ? (
                <CheckCircle className="h-8 w-8 text-green-500" />
              ) : paymentStatus === "failed" ? (
                <AlertCircle className="h-8 w-8 text-red-500" />
              ) : (
                <Loader className="h-8 w-8 text-blue-500 animate-spin" />
              )}
            </div>
            
            <div className="text-center space-y-3 mb-6">
              {paymentStatus === "success" ? (
                <>
                  <p className="text-lg font-semibold text-green-600">Account Activated</p>
                  <p className="text-sm text-green-600/80">Activation completed successfully</p>
                  <p className="text-sm text-green-600/80">Your withdrawal access is now enabled</p>
                </>
              ) : paymentStatus === "failed" ? (
                <>
                  <p className="text-lg font-semibold text-red-600">Failed</p>
                  <p className="text-sm text-red-600/80">Activation failed.</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-semibold text-blue-600">Activating.....</p>
                  <p className="text-sm text-blue-600/80">Verifying transaction details</p>
                  <p className="text-sm text-blue-600/80">Processing payment</p>
                  <p className="text-sm text-blue-600/80">Updating account status</p>
                  <p className="text-sm text-blue-600/80">Finalizing activation</p>
                </>
              )}
            </div>

            <div className="text-xs text-center">
              {paymentStatus === "success" ? (
                <p className="text-green-600/70">Closing in a moment...</p>
              ) : paymentStatus === "failed" ? (
                <p className="text-red-600/70">Please try again.</p>
              ) : (
                <p className="text-blue-600/60">Please wait while we complete your activation...</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
