import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TrendingUp, TrendingDown, Calendar, Zap } from "lucide-react";
import { useBets } from "@/context/BetContext";
import { useTransactions } from "@/context/TransactionContext";
import { useUser } from "@/context/UserContext";
import { useNavigate } from "react-router-dom";
import { formatTransactionDateInEAT } from "@/lib/timezoneFormatter";
import { useEffect, useCallback, useRef } from "react";

interface HistoryEntry {
  id: string;
  type: "bet" | "transaction" | "bonus";
  originalType?: string;
  description: string;
  amount: number;
  status: "completed" | "pending" | "failed";
  date: string;
}

export default function History() {
  const { bets } = useBets();
  const { getUserTransactions, getUserActivationFees, fetchTransactions, isLoading } = useTransactions();
  const { user } = useUser();
  const navigate = useNavigate();
  const lastFetchRef = useRef<number>(0);

  const refresh = useCallback(() => {
    if (!user?.id) return;
    const now = Date.now();
    // Debounce: don't re-fetch if we fetched less than 5 seconds ago
    if (now - lastFetchRef.current < 5000) return;
    lastFetchRef.current = now;
    fetchTransactions(user.id);
  }, [user?.id, fetchTransactions]);

  // Fetch on mount and whenever user.id becomes available
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch when the tab becomes visible again (user switches back)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  
  // Get user's transactions
  const userTransactions = getUserTransactions(user?.id || "user1");
  const userActivationFees = getUserActivationFees(user?.id || "user1");
  
  // Convert bets to history entries
  const betHistory: HistoryEntry[] = bets.map((bet) => ({
    id: bet.betId,
    type: "bet" as const,
    description: `${bet.selections[0]?.match || "Bet"} - ${bet.selections[0]?.type || "Unknown"}`,
    amount: -bet.stake,
    status: (bet.status === "Won" || bet.status === "Open" ? "completed" : bet.status === "Lost" ? "completed" : "completed") as "completed" | "pending" | "failed",
    date: `${bet.date} ${bet.time}`,
  }));
  
  // Convert transactions to history entries
  const transactionHistory: HistoryEntry[] = userTransactions.map((t) => ({
    id: t.id,
    type: "transaction" as const,
    originalType: t.type,
    description: t.type === "deposit" ? "M-Pesa Deposit" : "M-Pesa Withdrawal",
    amount: t.type === "deposit" ? t.amount : -t.amount,
    status: t.status as "completed" | "pending" | "failed",
    date: t.date,
  }));

  // Convert activation fees to history entries
  const activationHistory: HistoryEntry[] = userActivationFees.map((f) => ({
    id: f.id,
    type: "transaction" as const,
    originalType: f.fee_type === 'activation' ? 'activation' : 'priority',
    description: f.fee_type === 'activation' ? 'Activation Fee' : 'Priority Fee',
    amount: -f.amount,
    status: (f.status === 'completed' || f.status === 'pending' || f.status === 'failed' ? f.status : 'pending') as "completed" | "pending" | "failed",
    date: new Date(f.created_at).toLocaleString(),
  }));
  
  // Combine all history items and sort by date (most recent first)
  const history: HistoryEntry[] = [...betHistory, ...transactionHistory, ...activationHistory].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  
  // Derived history arrays (already calculated above)

  const getIcon = (type: string) => {
    switch (type) {
      case "bet":
        return <TrendingDown className="h-5 w-5" />;
      case "transaction":
        return <TrendingUp className="h-5 w-5" />;
      case "bonus":
        return <Calendar className="h-5 w-5" />;
      default:
        return null;
    }
  };

  const getThumbnailColor = (type: string, amount: number) => {
    if (type === "bonus") return "bg-gold/20";
    if (amount > 0) return "bg-green-500/20";
    return "bg-blue-500/20";
  };

  const getAmountColor = (type: string, amount: number) => {
    if (type === "bonus") return "text-gold";
    if (amount > 0) return "text-green-500";
    return "text-blue-500";
  };

  const HistoryCard = ({ entry }: { entry: HistoryEntry }) => (
    <Card className="border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`rounded-full p-3 ${getThumbnailColor(entry.type, entry.amount)}`}>
            {getIcon(entry.type)}
          </div>
          <div>
            <p className="font-medium text-foreground">{entry.description}</p>
            <div className="mt-1 flex items-center gap-2">
              <Calendar className="h-3 w-3 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{formatTransactionDateInEAT(entry.date)}</p>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className={`font-bold ${getAmountColor(entry.type, entry.amount)}`}>
            {entry.amount > 0 ? "+" : ""}KSH {Math.abs(entry.amount).toLocaleString()}
          </p>
          <div className="mt-1 flex items-center justify-end gap-2">
            <Badge
              className={`${
                entry.status === "completed"
                  ? "bg-green-500/20 text-green-500"
                  : entry.status === "pending"
                    ? "bg-yellow-500/20 text-yellow-500"
                    : "bg-red-500/20 text-red-500"
              }`}
            >
              {entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}
            </Badge>
            {entry.originalType === "withdrawal" && entry.status === "pending" && (
              <Button
                variant="outline"
                size="sm"
                className="border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-400"
                onClick={() => navigate(`/priority-withdrawal?txId=${entry.id}&amount=${Math.abs(entry.amount)}`)}
              >
                <Zap className="mr-1 h-3 w-3" />
                Prioritize
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-foreground">
            History
          </h1>
          <p className="mt-2 text-muted-foreground">
            View your account activity and transaction history
          </p>
        </div>

        {/* Summary Stats */}
        <div className="mb-8 grid gap-4 md:grid-cols-3">
          <Card className="border-primary/30 bg-card p-4">
            <p className="text-xs text-muted-foreground">Total Bets</p>
            <p className="mt-2 text-2xl font-bold text-foreground">
              {betHistory.length}
            </p>
          </Card>
          <Card className="border-primary/30 bg-card p-4">
            <p className="text-xs text-muted-foreground">Total Wagered</p>
            <p className="mt-2 text-2xl font-bold text-blue-500">
              KSH{" "}
              {Math.abs(
                betHistory.reduce((sum, h) => sum + h.amount, 0)
              ).toLocaleString()}
            </p>
          </Card>
          <Card className="border-primary/30 bg-card p-4">
            <p className="text-xs text-muted-foreground">Transactions</p>
            <p className="mt-2 text-2xl font-bold text-foreground">
              {transactionHistory.length + activationHistory.length}
            </p>
          </Card>
        </div>

        {/* History Tabs */}
        <Tabs defaultValue="all">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="all">All ({history.length})</TabsTrigger>
            <TabsTrigger value="bets">Bets ({betHistory.length})</TabsTrigger>
            <TabsTrigger value="transactions">
              Transactions ({transactionHistory.length + activationHistory.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="mt-6 space-y-3">
            {history.map((entry) => (
              <HistoryCard key={entry.id} entry={entry} />
            ))}
          </TabsContent>

          <TabsContent value="bets" className="mt-6 space-y-3">
            {betHistory.length === 0 ? (
              <Card className="border-border bg-card p-8 text-center">
                <p className="text-muted-foreground">No bets found</p>
              </Card>
            ) : (
              betHistory.map((entry) => (
                <HistoryCard key={entry.id} entry={entry} />
              ))
            )}
          </TabsContent>

          <TabsContent value="transactions" className="mt-6 space-y-3">
            {transactionHistory.length === 0 && activationHistory.length === 0 ? (
              <Card className="border-border bg-card p-8 text-center">
                <p className="text-muted-foreground">No transactions found</p>
              </Card>
            ) : (
              [...transactionHistory, ...activationHistory]
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                .map((entry) => (
                <HistoryCard key={entry.id} entry={entry} />
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <BottomNav />
    </div>
  );
}
