import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MatchCard, type Match } from "@/components/MatchCard";
import { FinishedMatchCard } from "@/components/FinishedMatchCard";
import { BettingSlip, type BetSlipItem } from "@/components/BettingSlip";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { TrendingUp, Search } from "lucide-react";
import { useBetAutoCalculation } from "@/hooks/useBetAutoCalculation";
import { useOdds } from "@/context/OddsContext";
import { useUser } from "@/context/UserContext";
import { getPicksFromUrl } from "@/lib/shareableLinks";
import { buildApiUrl } from "@/lib/api";

type MatchView = "hot" | "upcoming" | "live" | "ended";

interface IndexProps {
  sport?: string;
}

const getMarketFromType = (type: string): string => {
  if (['home', 'draw', 'away'].includes(type)) return '1X2';
  if (type.startsWith('btts')) return 'BTTS';
  if (['over15', 'under15', 'over25', 'under25'].includes(type)) return 'O/U';
  if (type.startsWith('dc')) return 'DC';
  if (type.startsWith('htft')) return 'HT/FT';
  if (type.startsWith('cs')) return 'CS';
  return '1X2';
};

// Helper function to sort games by upcoming kickoff time (closest first)
const sortGamesByKickoffTime = (games: any[]) => {
  return [...games].sort((a, b) => {
    try {
      const timeA = new Date(a.time).getTime();
      const timeB = new Date(b.time).getTime();
      return timeA - timeB; // Earlier times first (upcoming)
    } catch (e) {
      return 0; // If time parsing fails, maintain order
    }
  });
};

const sortEndedGames = (games: any[]) => {
  return [...games].sort((a, b) => {
    try {
      const timeA = new Date(a.time).getTime();
      const timeB = new Date(b.time).getTime();
      return timeB - timeA;
    } catch (e) {
      return 0;
    }
  });
};

const isFutureKickoff = (time: string) => {
  const kickoffMs = new Date(time).getTime();
  return !Number.isNaN(kickoffMs) && kickoffMs > Date.now();
};

const Index = ({ sport = 'football' }: IndexProps) => {
  const { isLoggedIn } = useUser();
  const [betSlip, setBetSlip] = useState<BetSlipItem[]>(() => {
    try {
      const raw = localStorage.getItem('betSlipItems');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [selectedOdds, setSelectedOdds] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('selectedOddsMap');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeView, setActiveView] = useState<MatchView>("upcoming");
  const [invalidPicksMessage, setInvalidPicksMessage] = useState<string>("");
  const [isLoadingBetslip, setIsLoadingBetslip] = useState(false);
  const { games: apiGames, isLoading: isLoadingGames } = useOdds();
  const apiBaseUrl = buildApiUrl('/api');

  // Validate picks against current games
  const validatePicks = (picks: BetSlipItem[], gamesToCheck: any[]): { valid: BetSlipItem[]; invalid: boolean; message: string } => {
    const validPicks: BetSlipItem[] = [];
    
    // If games are still loading, don't validate yet - show loading message
    if (gamesToCheck.length === 0 && isLoadingGames) {
      return { valid: [], invalid: false, message: "" }; // Wait for games to load
    }
    
    for (const pick of picks) {
      const game = gamesToCheck.find(g => g.id === pick.matchId);
      
      if (!game) {
        // Game doesn't exist
        return { valid: [], invalid: true, message: `Game "${pick.match}" does not exist.` };
      }
      
      if (game.status === "finished") {
        // Game has ended
        return { valid: [], invalid: true, message: `Game "${pick.match}" has already ended. Selections are no longer valid.` };
      }
      
      if (game.status === "live") {
        // Game is live - can't use for pre-match picks
        return { valid: [], invalid: true, message: `Game "${pick.match}" is currently live. Only live bets are available.` };
      }
      
      validPicks.push(pick);
    }
    
    return { valid: validPicks, invalid: false, message: "" };
  };

  // Auto-cleanup selections when games kick off
  useEffect(() => {
    if (betSlip.length === 0) return;
    
    // Find games that have kicked off
    const gamesWithKickOff = betSlip.filter(pick => {
      const game = apiGames.find(g => g.id === pick.matchId);
      return game && (game.status === "live" || game.status === "finished");
    });
    
    if (gamesWithKickOff.length > 0) {
      // Remove selections for games that have kicked off
      const updatedBetSlip = betSlip.filter(pick => {
        const game = apiGames.find(g => g.id === pick.matchId);
        return !game || (game.status !== "live" && game.status !== "finished");
      });
      
      if (updatedBetSlip.length < betSlip.length) {
        setBetSlip(updatedBetSlip);
        
        // Update selectedOdds map
        const newOddsMap: Record<string, string> = {};
        updatedBetSlip.forEach(item => {
          newOddsMap[item.matchId] = `${item.matchId}-${item.type}`;
        });
        setSelectedOdds(newOddsMap);
      }
    }
  }, [apiGames]);

  // Persist bet slip selections so they remain even if match cards move/disappear.
  useEffect(() => {
    localStorage.setItem('betSlipItems', JSON.stringify(betSlip));
  }, [betSlip]);

  useEffect(() => {
    localStorage.setItem('selectedOddsMap', JSON.stringify(selectedOdds));
  }, [selectedOdds]);

  // Load picks from URL if shared link
  useEffect(() => {
    const loadPicksFromUrl = async () => {
      let urlPicks = await getPicksFromUrl();
      
      // Check sessionStorage for pending picks (from signup redirect)
      if (urlPicks.length === 0) {
        try {
          const pendingPicks = sessionStorage.getItem("pendingPicks");
          if (pendingPicks) {
            // Restore the URL with picks parameter
            const newUrl = `${window.location.pathname}?picks=${pendingPicks}`;
            window.history.replaceState({}, "", newUrl);
            
            // Re-read from URL
            urlPicks = await getPicksFromUrl();
            sessionStorage.removeItem("pendingPicks");
          }
        } catch (error) {
          console.error("Failed to restore pending picks:", error);
        }
      }
      
      if (urlPicks.length > 0) {
        // Only load if bet slip is empty (to avoid overwriting)
        if (betSlip.length === 0) {
          // Show loading state if games are still loading
          if (isLoadingGames && apiGames.length === 0) {
            setIsLoadingBetslip(true);
            setInvalidPicksMessage(""); // Clear any previous error
            return;
          }
          
          // Validate picks against current games
          const validation = validatePicks(urlPicks, apiGames);
          
          if (validation.invalid) {
            setInvalidPicksMessage(validation.message);
            setIsLoadingBetslip(false);
            // Don't load invalid picks
            return;
          }
          
          // Games loaded and validation passed
          setBetSlip(validation.valid);
          // Build selectedOdds map from URL picks
          const oddsMap: Record<string, string> = {};
          validation.valid.forEach(item => {
            oddsMap[item.matchId] = `${item.matchId}-${item.type}`;
          });
          setSelectedOdds(oddsMap);
          setIsLoadingBetslip(false);
        }
      }
    };

    loadPicksFromUrl();
  }, [apiGames, isLoadingGames]); // Re-run when games or loading state changes

  // Enable auto bet calculation
  useBetAutoCalculation();

  // Show all games including finished ones, filtered by sport
  const games = apiGames.filter((g) => (g.sport || 'football') === sport);

  const filteredGames = searchQuery.trim()
    ? games.filter((g) => {
        const q = searchQuery.toLowerCase();
        return (
          g.homeTeam?.toLowerCase().includes(q) ||
          g.awayTeam?.toLowerCase().includes(q) ||
          g.league?.toLowerCase().includes(q)
        );
      })
    : games;

  const hotGames = sortGamesByKickoffTime(
    filteredGames.filter((g) => g.isHot && g.status !== "finished")
  );
  const upcomingGames = sortGamesByKickoffTime(
    filteredGames.filter((g) => g.status === "upcoming" && isFutureKickoff(g.time))
  );
  const liveGames = filteredGames.filter((g) => g.status === "live");
  const endedGames = sortEndedGames(filteredGames.filter((g) => g.status === "finished"));

  const handleSelectOdd = (matchId: string, type: string, odds: number, match: Match) => {
    const key = `${matchId}-${type}`;
    if (selectedOdds[matchId] === key) {
      setSelectedOdds((prev) => { const next = { ...prev }; delete next[matchId]; return next; });
      setBetSlip((prev) => prev.filter((i) => i.matchId !== matchId));
    } else {
      setSelectedOdds((prev) => ({ ...prev, [matchId]: key }));
      const market = getMarketFromType(type);
      setBetSlip((prev) => [
        ...prev.filter((i) => i.matchId !== matchId),
        { matchId, match: `${match.homeTeam} vs ${match.awayTeam}`, type, market, odds },
      ]);
    }
  };

  // Sport display info
  const sportEmoji: Record<string, string> = { football: '⚽', basketball: '🏀', tennis: '🎾', cricket: '🏏', boxing: '🥊' };
  const sportLabel = sport.charAt(0).toUpperCase() + sport.slice(1);
  const emoji = sportEmoji[sport] || '⚽';

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header />

      {/* Search Bar */}
      <section className="container mx-auto px-4 pt-4 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search teams or leagues..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg bg-secondary border border-border pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>
      </section>

      {/* Invalid Picks Alert */}
      {invalidPicksMessage && (
        <section className="container mx-auto px-4 py-2">
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3">
            <p className="text-sm text-red-600 font-medium">⚠️ {invalidPicksMessage}</p>
          </div>
        </section>
      )}

      {/* Matches - Organized by Status */}
      <section className="container mx-auto px-4 py-4">
        <div className={`mb-6 grid gap-2 ${isLoggedIn ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <Button
            variant={activeView === "upcoming" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("upcoming")}
            className="w-full text-xs sm:text-sm"
          >
            Upcoming
          </Button>
          <Button
            variant={activeView === "hot" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("hot")}
            className="w-full text-xs sm:text-sm"
          >
            <span className="emoji mr-1 inline-block leading-none">🔥</span>
            Hot
          </Button>
          <Button
            variant={activeView === "live" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("live")}
            className="w-full text-xs sm:text-sm"
          >
            LIVE
          </Button>
          {isLoggedIn && (
            <Button
              variant={activeView === "ended" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveView("ended")}
              className="w-full text-xs sm:text-sm"
            >
              ENDED
            </Button>
          )}
        </div>

        {activeView === "upcoming" && upcomingGames.length > 0 && (
          <div className="mb-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                <TrendingUp className="mr-2 inline h-5 w-5 text-primary" />
                Upcoming {sportLabel} {emoji}
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {upcomingGames.map((game) => {
                const match: Match = {
                  id: game.id,
                  league: game.league,
                  homeTeam: game.homeTeam,
                  awayTeam: game.awayTeam,
                  homeOdds: game.homeOdds,
                  drawOdds: game.drawOdds,
                  awayOdds: game.awayOdds,
                  time: game.time,
                  markets: game.markets,
                };
                return (
                  <MatchCard
                    key={game.id}
                    match={match}
                    onSelectOdd={(id, type, odds) => handleSelectOdd(id, type, odds, match)}
                    selectedOdd={selectedOdds[game.id] || null}
                  />
                );
              })}
            </div>
          </div>
        )}

        {activeView === "hot" && hotGames.length > 0 && (
          <div className="mb-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                <span className="emoji mr-2 inline-block text-lg leading-none">🔥</span>
                Hot Matches <span className="emoji inline-block leading-none">🔥</span>
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {hotGames.map((game) => {
                const match: Match = {
                  id: game.id,
                  league: game.league,
                  homeTeam: game.homeTeam,
                  awayTeam: game.awayTeam,
                  homeOdds: game.homeOdds,
                  drawOdds: game.drawOdds,
                  awayOdds: game.awayOdds,
                  time: game.time,
                  markets: game.markets,
                };
                return (
                  <MatchCard
                    key={game.id}
                    match={match}
                    onSelectOdd={(id, type, odds) => handleSelectOdd(id, type, odds, match)}
                    selectedOdd={selectedOdds[game.id] || null}
                  />
                );
              })}
            </div>
          </div>
        )}

        {activeView === "live" && liveGames.length > 0 && (
          <div className="mb-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                <span className="inline-block h-3 w-3 rounded-full bg-live mr-2 animate-pulse" />
                LIVE {sportLabel} {emoji}
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {liveGames.map((game) => {
                const match: Match = {
                  id: game.id,
                  league: game.league,
                  homeTeam: game.homeTeam,
                  awayTeam: game.awayTeam,
                  homeOdds: game.homeOdds,
                  drawOdds: game.drawOdds,
                  awayOdds: game.awayOdds,
                  time: game.time,
                  markets: game.markets,
                };
                return (
                  <MatchCard
                    key={game.id}
                    match={match}
                    onSelectOdd={(id, type, odds) => handleSelectOdd(id, type, odds, match)}
                    selectedOdd={selectedOdds[game.id] || null}
                  />
                );
              })}
            </div>
          </div>
        )}

        {isLoggedIn && activeView === "ended" && endedGames.length > 0 && (
          <div className="mb-10">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                <span className="text-gray-500 mr-2">✓</span>
                Ended Matches
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {endedGames
                .slice(0, showAllFinished ? undefined : 6)
                .map((game) => (
                  <FinishedMatchCard
                    key={game.id}
                    match={{
                      id: game.id,
                      league: game.league,
                      homeTeam: game.homeTeam,
                      awayTeam: game.awayTeam,
                      time: game.time,
                      homeScore: game.homeScore,
                      awayScore: game.awayScore,
                    }}
                  />
                ))}
            </div>
            {endedGames.length > 6 && !showAllFinished && (
              <Button
                onClick={() => setShowAllFinished(true)}
                className="mt-4 w-full"
                variant="outline"
              >
                Show More Matches
              </Button>
            )}
            {showAllFinished && endedGames.length > 6 && (
              <Button
                onClick={() => setShowAllFinished(false)}
                className="mt-4 w-full"
                variant="outline"
              >
                Show Less
              </Button>
            )}
          </div>
        )}

        {((activeView === "hot" && hotGames.length === 0) ||
          (activeView === "upcoming" && upcomingGames.length === 0) ||
          (activeView === "live" && liveGames.length === 0) ||
          (isLoggedIn && activeView === "ended" && endedGames.length === 0)) && (
          <div className="text-center py-12">
            {isLoadingGames && apiGames.length === 0 ? (
              <div>
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                <p className="text-muted-foreground">Matches are loading kindly wait...</p>
              </div>
            ) : (
              <p className="text-muted-foreground">
                {searchQuery ? `No matches found for "${searchQuery}"` : activeView === "hot" ? "No hot matches right now. Check upcoming!" : `No ${activeView} matches available right now.`}
              </p>
            )}
          </div>
        )}

        {isLoadingBetslip && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-background rounded-lg p-8 text-center">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-foreground">Loading betting slip...</p>
            </div>
          </div>
        )}
      </section>

      <BettingSlip
        items={betSlip}
        onRemove={(id) => {
          setBetSlip((prev) => prev.filter((i) => i.matchId !== id));
          setSelectedOdds((prev) => { const next = { ...prev }; delete next[id]; return next; });
        }}
        onClear={() => { setBetSlip([]); setSelectedOdds({}); }}
      />

      {isLoggedIn && <BottomNav />}
    </div>
  );
};

export default Index;
