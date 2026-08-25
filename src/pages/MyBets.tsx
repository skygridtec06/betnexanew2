import { useState, useEffect, useRef } from "react";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getPickLabel } from "@/components/BettingSlip";
import { useBets } from "@/context/BetContext";
import { useOdds } from "@/context/OddsContext";
import { useUser } from "@/context/UserContext";
import { calculateMatchMinute } from "@/lib/gameTimeCalculator";
import { validateBetOutcome } from "@/lib/betOutcomeValidator";
import { formatKickoffTimeEAT } from "@/lib/timeFormatter";
import { formatDateTimeForDisplayEAT } from "@/lib/timezoneFormatter";
import {
  Share2,
  RotateCcw,
  Clock,
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";

function getPlacedDateTimeEAT(createdAt?: string, fallbackDate?: string, fallbackTime?: string) {
  const format12h = (hours24: number, minutes: number) => {
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    let h = hours24 % 12;
    h = h === 0 ? 12 : h;
    return `${h}:${String(minutes).padStart(2, '0')} ${ampm}`;
  };

  const addThreeHoursToDate = (base: Date) => new Date(base.getTime() + 3 * 60 * 60 * 1000);

  try {
    if (createdAt) {
      const formatted = formatDateTimeForDisplayEAT(createdAt);
      if (formatted.date !== 'N/A' && formatted.time !== 'N/A') {
        return formatted;
      }
    }

    if (fallbackDate && fallbackTime) {
      const fallbackDateValue = String(fallbackDate).trim();
      const fallbackTimeValue = String(fallbackTime).trim();
      if (fallbackDateValue && fallbackTimeValue) {
        return {
          date: fallbackDateValue,
          time: fallbackTimeValue,
        };
      }
    }

    return {
      date: fallbackDate || new Date().toLocaleDateString('en-GB'),
      time: fallbackTime || format12h(new Date().getHours(), new Date().getMinutes()),
    };
  } catch {
    return {
      date: fallbackDate || 'N/A',
      time: fallbackTime || 'N/A',
    };
  }
}

export default function MyBets() {
  const { bets, setBets } = useBets();
  const { games } = useOdds();
  const { user } = useUser();
  const [expandedBetId, setExpandedBetId] = useState<string | null>(null);
  const [liveMinutes, setLiveMinutes] = useState<Record<string, { minute: number; seconds: number }>>({});
  const [editingSelectionId, setEditingSelectionId] = useState<string | null>(null);
  const [isUpdatingOutcome, setIsUpdatingOutcome] = useState(false);

  // Update live game display times - reads from game state every second
  useEffect(() => {
    const interval = setInterval(() => {
      const newMinutes: Record<string, { minute: number; seconds: number }> = {};
      games.forEach((game) => {
        if (game.isKickoffStarted) {
          newMinutes[game.id] = { 
            minute: game.minute || 0, 
            seconds: game.seconds || 0 
          };
        }
      });
      
      // Only update state if there are new minutes AND they differ from current state
      if (Object.keys(newMinutes).length > 0) {
        setLiveMinutes((prevMinutes) => {
          // Check if values actually changed to prevent unnecessary re-renders
          const hasChanged = Object.keys(newMinutes).some(
            (id) => !prevMinutes[id] || 
                   prevMinutes[id].minute !== newMinutes[id].minute ||
                   prevMinutes[id].seconds !== newMinutes[id].seconds
          );
          
          return hasChanged ? newMinutes : prevMinutes;
        });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [games]);

  // Load bets from server on page load (multi-device sync)
  useEffect(() => {
    if (!user?.phone) return;

    const loadBetsFromServer = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
        const response = await fetch(`${apiUrl}/api/bets/user?phoneNumber=${encodeURIComponent(user.phone)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store'
        });

        const data = await response.json();

        if (data.success && data.bets) {
          // Transform backend bets to frontend format
          const transformedBets = data.bets.map((bet: any) => {
            const placed = getPlacedDateTimeEAT(bet.created_at, bet.bet_date, bet.bet_time);
            return {
              ...(() => {
                const base = { date: placed.date, time: placed.time };
                return base;
              })(),
              id: bet.id,
              betId: bet.bet_id,
              createdAt: bet.created_at,
              stake: parseFloat(bet.stake),
              potentialWin: parseFloat(bet.potential_win),
              amountWon: bet.amount_won ? parseFloat(bet.amount_won) : undefined,
              totalOdds: parseFloat(bet.total_odds),
              status: bet.status,
              selections: (bet.selections || []).map((sel: any) => ({
                matchId: sel.gameRefId || sel.game_id || sel.matchId,
                match: `${sel.home_team} vs ${sel.away_team}`,
                type: sel.market_key,
                market: sel.market_type,
                odds: parseFloat(sel.odds)
              }))
            };
          });

          setBets(transformedBets);
          console.log(`✅ Loaded ${transformedBets.length} bets from server`);
        }
      } catch (error) {
        console.error('⚠️ Failed to load bets from server:', error);
      }
    };

    loadBetsFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.phone]);

  // Helper function to get match status and outcome - MUST BE DEFINED FIRST
  const getMatchStatus = (matchId: string, selection: typeof bets[0]["selections"][0]) => {
    const game = games.find((g) => g.id === matchId);
    
    if (!game) return { status: "pending", outcome: "pending" };

    if (game.status === "finished" && game.homeScore !== undefined && game.awayScore !== undefined) {
      const homeScore = game.homeScore;
      const awayScore = game.awayScore;
      
      // Use comprehensive bet outcome validation
      const betWon = validateBetOutcome(selection.type, homeScore, awayScore);
      const outcome = betWon ? "won" : "lost";
      
      return { status: "finished", outcome };
    }

    if (game.status === "live" && game.isKickoffStarted) return { status: "live", outcome: "pending" };
    
    return { status: "pending", outcome: "pending" };
  };

  // Calculate bet outcome based on selections
  const calculateBetOutcome = (bet: typeof bets[0]) => {
    if (bet.status !== "Open") return bet.status;
    
    // Check if any selection is lost - if so, bet is lost
    const hasLostSelection = bet.selections.some(sel => {
      const matchStatus = getMatchStatus(sel.matchId, sel);
      return matchStatus.status === "finished" && matchStatus.outcome === "lost";
    });
    
    if (hasLostSelection) return "Lost";
    
    // Check if all selections are finished and won
    const allFinished = bet.selections.every(sel => getMatchStatus(sel.matchId, sel).status === "finished");
    const allWon = bet.selections.every(sel => getMatchStatus(sel.matchId, sel).outcome === "won");
    
    if (allFinished && allWon) return "Won";
    
    return "Open";
  };

  // Organize bets by match status
  const upcomingBets = bets.filter((b) => {
    const allStatuses = b.selections.map(sel => getMatchStatus(sel.matchId, sel).status);
    return allStatuses.every(s => s === "pending");
  });
  
  const liveBets = bets.filter((b) => {
    const statuses = b.selections.map(sel => getMatchStatus(sel.matchId, sel).status);
    return statuses.includes("live") && !statuses.every(s => s === "finished");
  });
  
  const settledBets = bets.filter((b) => {
    // If bet has been manually settled by admin, show it in settled section
    if (b.status !== "Open") return true;
    
    // Otherwise, only show if all games are finished
    const allStatuses = b.selections.map(sel => getMatchStatus(sel.matchId, sel).status);
    return allStatuses.every(s => s === "finished");
  });

  // Handle updating selection outcome (admin only)
  const updateSelectionOutcome = async (betId: string, selectionId: string, newOutcome: 'won' | 'lost') => {
    if (!user?.isAdmin) {
      alert('Only admins can edit outcomes');
      return;
    }

    setIsUpdatingOutcome(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/bets/${betId}/selections/${selectionId}/outcome`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          outcome: newOutcome,
          phone: user.phone 
        })
      });

      const data = await response.json();

      if (data.success) {
        // Update local state - refresh bets from server
        const refreshResponse = await fetch(`${apiUrl}/api/bets/user?phoneNumber=${encodeURIComponent(user.phone)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        const refreshData = await refreshResponse.json();

        if (refreshData.success && refreshData.bets) {
          const transformedBets = refreshData.bets.map((bet: any) => ({
            ...(() => {
              const placed = getPlacedDateTimeEAT(bet.created_at, bet.bet_date, bet.bet_time);
              return { date: placed.date, time: placed.time };
            })(),
            id: bet.id,
            betId: bet.bet_id,
            createdAt: bet.created_at,
            stake: parseFloat(bet.stake),
            potentialWin: parseFloat(bet.potential_win),
            amountWon: bet.amount_won ? parseFloat(bet.amount_won) : undefined,
            totalOdds: parseFloat(bet.total_odds),
            status: bet.status,
            selections: (bet.selections || []).map((sel: any) => ({
              matchId: sel.gameRefId || sel.game_id || sel.matchId,
              match: `${sel.home_team} vs ${sel.away_team}`,
              type: sel.market_key,
              market: sel.market_type,
              odds: parseFloat(sel.odds)
            }))
          }));

          setBets(transformedBets);
          setEditingSelectionId(null);
          alert('Outcome updated successfully');
        }
      } else {
        alert('Failed to update outcome: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error updating outcome:', error);
      alert('Error updating outcome: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsUpdatingOutcome(false);
    }
  };

  const activeBets = bets.filter((b) => {
    const outcome = calculateBetOutcome(b);
    return outcome === "Open";
  });

  const totalStake = bets.reduce((sum, b) => sum + b.stake, 0);
  const totalWinnings = bets
    .filter((b) => calculateBetOutcome(b) === "Won")
    .reduce((sum, b) => sum + b.potentialWin, 0);

  const BetSummary = ({ bet }: { bet: typeof bets[0] }) => {
    const betOutcome = calculateBetOutcome(bet);
    return (
      <button
        onClick={() => setExpandedBetId(bet.id)}
        className="w-full text-left"
      >
        <Card className="border-border bg-card overflow-hidden hover:bg-card/80 transition-colors">
          <div className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline">#{bet.betId}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {bet.date} {bet.time} EAT
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Stake</p>
                    <p className="font-bold text-foreground">KSH {bet.stake.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Possible Win</p>
                    <p className="font-bold text-gold">KSH {bet.potentialWin.toLocaleString()}</p>
                  </div>
                </div>
              </div>
              <Badge
                className={
                  betOutcome === "Open"
                    ? "bg-blue-500/20 text-blue-500"
                    : betOutcome === "Won"
                      ? "bg-green-500/20 text-green-500"
                      : "bg-red-500/20 text-red-500"
                }
              >
                {betOutcome}
              </Badge>
            </div>
          </div>
        </Card>
      </button>
    );
  };

  const FullScreenBetDetail = ({ bet }: { bet: typeof bets[0] }) => {
    const betOutcome = calculateBetOutcome(bet);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const scrollPositionRef = useRef<number>(0);

    // Preserve scroll position when component updates
    useEffect(() => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;

      const handleScroll = () => {
        scrollPositionRef.current = scrollContainer.scrollTop;
      };

      scrollContainer.addEventListener("scroll", handleScroll);
      return () => scrollContainer.removeEventListener("scroll", handleScroll);
    }, []);

    // Restore scroll position on re-render (when liveMinutes updates)
    useEffect(() => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer && scrollPositionRef.current > 0) {
        scrollContainer.scrollTop = scrollPositionRef.current;
      }
    });

    return (
      <div className="fixed inset-0 bg-background z-50 flex flex-col pb-24">
      {/* Header */}
      <div className="border-b border-border/50 p-4 flex items-center justify-between">
        <Button
          onClick={() => setExpandedBetId(null)}
          variant="ghost"
          size="icon"
          className="text-primary"
        >
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <h2 className="font-display text-lg font-bold text-foreground">
          Bet Details
        </h2>
        <div className="w-10" /> {/* Spacer for alignment */}
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4">
        <div className="space-y-6">
          {/* Bet ID and Status */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-2xl font-bold text-foreground">
                {bet.betId}
              </h3>
              <Badge
                className={
                  betOutcome === "Open"
                    ? "bg-blue-500/20 text-blue-500"
                    : betOutcome === "Won"
                      ? "bg-green-500/20 text-green-500"
                      : "bg-red-500/20 text-red-500"
                }
              >
                {betOutcome}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Prematch Bet placed on {bet.date} at {bet.time} EAT
            </p>
          </div>

          {/* Stats Grid - Always 3 columns horizontally */}
          <div className="grid grid-cols-3 gap-2">
            <Card className="bg-secondary/50 border-border p-3">
              <p className="text-xs text-muted-foreground mb-1">Amount</p>
              <p className="font-bold text-foreground text-sm">KSH {bet.stake.toLocaleString()}</p>
            </Card>
            <Card className="bg-secondary/50 border-border p-3">
              <p className="text-xs text-muted-foreground mb-1">
                {betOutcome === "Open" ? "Possible Payout" : betOutcome === "Won" ? "Amount Won" : "Amount Lost"}
              </p>
              <p className={`font-bold text-sm ${
                betOutcome === "Won" 
                  ? "text-green-500" 
                  : betOutcome === "Lost"
                  ? "text-red-500"
                  : "text-gold"
              }`}>
                KSH {(betOutcome === "Won" && bet.amountWon ? bet.amountWon : bet.potentialWin).toLocaleString()}
              </p>
            </Card>
            {betOutcome === "Open" && (
              <Card className="bg-secondary/50 border-border p-3">
                <p className="text-xs text-muted-foreground mb-1">W/L/T</p>
                <p className="font-bold text-foreground text-sm">
                  {bet.selections.filter(sel => getMatchStatus(sel.matchId, sel).outcome === "won").length}/
                  {bet.selections.filter(sel => getMatchStatus(sel.matchId, sel).outcome === "lost" && getMatchStatus(sel.matchId, sel).status === "finished").length}/
                  {bet.selections.filter(sel => getMatchStatus(sel.matchId, sel).outcome === "pending").length}
                </p>
              </Card>
            )}
          </div>

          {/* Cashout Button - REMOVED */}

          {/* Events */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-display text-lg font-bold text-foreground">
                Events (Odds {bet.totalOdds})
              </h4>
              <button className="text-xs text-primary hover:underline">
                Collapse All
              </button>
            </div>

            <div className="space-y-4">
              {bet.selections.map((selection, idx) => (
                <Card key={idx} className="border-border bg-card p-4">
                  <div className="space-y-3">
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-3">
                        <div className="flex-1 text-right">
                          <p className="font-bold text-foreground text-sm">
                            {selection.match.split(" vs ")[0]}
                          </p>
                        </div>
                        <Badge className="bg-gold/30 text-gold border border-gold/50 px-3 py-1 text-xs font-bold">
                          vs
                        </Badge>
                        <div className="flex-1 text-left">
                          <p className="font-bold text-foreground text-sm">
                            {selection.match.split(" vs ")[1]}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Market</p>
                        <p className="font-medium text-foreground">
                          {selection.market === 'CS' ? 'CORRECT SCORE' : selection.market === 'O/U' ? 'OVER/UNDER' : selection.market === 'HT/FT' ? 'HALF TIME/FULL TIME' : selection.market === 'DC' ? 'DOUBLE CHANCE' : selection.market === 'BTTS' ? 'BOTH TEAMS TO SCORE' : selection.market}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Pick</p>
                        <p className="font-bold text-primary">
                          {getPickLabel(selection.type)} @ {selection.odds.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    {getMatchStatus(selection.matchId, selection).status === "live" ? (
                        <div className="text-sm">
                          <p className="text-xs text-muted-foreground mb-1">Score</p>
                          <div>
                            {games.find((g) => g.id === selection.matchId) && (
                              <p className="font-medium text-foreground">
                                {games.find((g) => g.id === selection.matchId)?.homeScore || 0} - {games.find((g) => g.id === selection.matchId)?.awayScore || 0}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm">
                          <p className="text-xs text-muted-foreground mb-1">
                            Start Time
                          </p>
                          <p className="font-medium text-foreground">
                            {games.find((g) => g.id === selection.matchId)?.time ? formatKickoffTimeEAT(games.find((g) => g.id === selection.matchId)!.time) : 'TBA'}
                          </p>
                        </div>
                      )}

                    {/* Outcome and Match Status on same row */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="px-2 py-1 bg-secondary/50 rounded">
                        <p className="text-muted-foreground mb-1">Outcome</p>
                        <div className="flex items-center gap-1">
                          {getMatchStatus(selection.matchId, selection).outcome === "won" && (
                            <>
                              <CheckCircle className="h-3 w-3 text-green-500" />
                              <p className="font-bold text-green-500 text-xs">Won</p>
                            </>
                          )}
                          {getMatchStatus(selection.matchId, selection).outcome === "lost" && getMatchStatus(selection.matchId, selection).status === "finished" && (
                            <>
                              <XCircle className="h-3 w-3 text-red-500" />
                              <p className="font-bold text-red-500 text-xs">Lost</p>
                            </>
                          )}
                          {getMatchStatus(selection.matchId, selection).outcome === "pending" && (
                            <>
                              <AlertCircle className="h-3 w-3 text-yellow-500" />
                              <p className="font-bold text-yellow-500 text-xs">Pending</p>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="px-2 py-1 bg-secondary/50 rounded">
                        <p className="text-muted-foreground mb-1">Status</p>
                        <div className="flex items-center gap-1">
                          {getMatchStatus(selection.matchId, selection).status === "finished" && (
                            <Badge variant="secondary" className="text-[9px] px-1 py-0">
                              FT {games.find((g) => g.id === selection.matchId)?.homeScore || 0}:{games.find((g) => g.id === selection.matchId)?.awayScore || 0}
                            </Badge>
                          )}
                          {getMatchStatus(selection.matchId, selection).status === "live" && (
                            <Badge variant="live" className="text-[9px] px-1 py-0">
                              LIVE {String(Math.floor(liveMinutes[selection.matchId]?.minute ?? games.find((g) => g.id === selection.matchId)?.minute ?? 0)).padStart(2, "0")}'
                            </Badge>
                          )}
                          {getMatchStatus(selection.matchId, selection).status === "pending" && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0">PENDING</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Full-screen bet detail modal */}
      {expandedBetId && (
        <FullScreenBetDetail
          bet={bets.find((b) => b.id === expandedBetId)!}
        />
      )}

      {/* Main content - hidden when modal is open */}
      {!expandedBetId && (
        <>
          <Header />

          <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
              <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-foreground">
                My Bets
              </h1>
              <p className="mt-2 text-muted-foreground">
                View your active and settled bets
              </p>
            </div>

            {/* Stats */}
            <div className="mb-8 grid gap-4 md:grid-cols-3">
              <Card className="border-primary/30 bg-card p-4">
                <p className="text-sm text-muted-foreground">Total Stake</p>
                <p className="mt-2 text-2xl font-bold text-foreground">
                  KSH {totalStake.toLocaleString()}
                </p>
              </Card>
              <Card className="border-primary/30 bg-card p-4">
                <p className="text-sm text-muted-foreground">Winnings</p>
                <p className="mt-2 text-2xl font-bold text-green-500">
                  KSH {totalWinnings.toLocaleString()}
                </p>
              </Card>
              <Card className="border-primary/30 bg-card p-4">
                <p className="text-sm text-muted-foreground">Active Bets</p>
                <p className="mt-2 text-2xl font-bold text-primary">
                  {activeBets.length}
                </p>
              </Card>
            </div>

            {/* Bets Tabs */}
            <Tabs defaultValue="active">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="active">
                  Active ({activeBets.length})
                </TabsTrigger>
                <TabsTrigger value="settled">
                  Settled ({settledBets.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="active" className="mt-6 space-y-3">
                {activeBets.length === 0 ? (
                  <Card className="border-border bg-card p-8 text-center">
                    <p className="text-muted-foreground">No active bets</p>
                  </Card>
                ) : (
                  activeBets.map((bet) => (
                    <BetSummary key={bet.id} bet={bet} />
                  ))
                )}
              </TabsContent>

              <TabsContent value="settled" className="mt-6 space-y-3">
                {settledBets.length === 0 ? (
                  <Card className="border-border bg-card p-8 text-center">
                    <p className="text-muted-foreground">No settled bets</p>
                  </Card>
                ) : (
                  settledBets.map((bet) => (
                    <BetSummary key={bet.id} bet={bet} />
                  ))
                )}
              </TabsContent>
            </Tabs>
          </div>

          <BottomNav />
        </>
      )}
    </div>
  );
}


