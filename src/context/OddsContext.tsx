import { createContext, useContext, useState, ReactNode, useEffect, useCallback, useRef } from "react";

export interface GameOdds {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  time: string;
  status: "upcoming" | "live" | "finished";
  markets: Record<string, number>;
  homeScore?: number;
  awayScore?: number;
  minute?: number;
  seconds?: number; // Seconds component for display
  kickoffStartTime?: number | string; // Timestamp when kickoff started (ISO string or milliseconds)
  isKickoffStarted?: boolean;
  gamePaused?: boolean;
  kickoffPausedAt?: number | string; // Timestamp when paused (ISO string or milliseconds)
  isHalftime?: boolean;
  sport?: string; // 'football' | 'basketball' | 'tennis' | 'cricket' | 'boxing'
  isHot?: boolean; // Hot/popular match
}

interface OddsContextType {
  games: GameOdds[];
  isLoading: boolean;
  addGame: (game: GameOdds) => void;
  updateGame: (id: string, game: Partial<GameOdds>) => void;
  removeGame: (id: string) => void;
  getGame: (id: string) => GameOdds | undefined;
  updateGameMarkets: (id: string, markets: Record<string, number>) => void;
  refreshGames: () => Promise<void>;
}

const OddsContext = createContext<OddsContextType | undefined>(undefined);

// Helper function to load cached games from localStorage
const loadCachedGames = (): GameOdds[] => {
  try {
    const cached = localStorage.getItem('betnexa_games_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log('📦 Loaded', parsed.length, 'cached games from localStorage');
        return parsed;
      }
    }
  } catch (error) {
    console.warn('⚠️ Error loading cached games:', error);
  }
  return [];
};

// Helper function to save games to localStorage cache
const saveCachedGames = (games: GameOdds[]): void => {
  try {
    localStorage.setItem('betnexa_games_cache', JSON.stringify(games));
  } catch (error) {
    console.warn('⚠️ Error saving games to cache:', error);
  }
};

export function OddsProvider({ children }: { children: ReactNode }) {
  const cachedGames = loadCachedGames();
  const [games, setGames] = useState<GameOdds[]>(cachedGames);
  const [isLoading, setIsLoading] = useState(cachedGames.length === 0); // Only loading if no cache
  const [loadError, setLoadError] = useState<string | null>(null);
  const gamesRef = useRef<GameOdds[]>(cachedGames);
  const kickoffTimesRef = useRef<Record<string, number>>({}); // Track when each game kicked off
  const fetchInProgressRef = useRef(false); // Prevent duplicate fetches

  const hasApiGamesNeedingSync = () => {
    const now = Date.now();
    return gamesRef.current.some((game) => {
      if (!game.id?.startsWith('af-') || game.status === 'finished') return false;
      if (game.status === 'live') return true;
      const kickoffMs = new Date(game.time).getTime();
      if (isNaN(kickoffMs)) return false;
      return kickoffMs <= now + 2 * 60 * 1000;
    });
  };

  // Fetch games from database - immediately on component mount, not in useEffect
  const performFetch = useCallback(async () => {
    if (fetchInProgressRef.current) return;
    fetchInProgressRef.current = true;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      
      console.log('🔄 Fetching fresh games from:', apiUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 second timeout

      const response = await fetch(`${apiUrl}/api/admin/games`, {
        signal: controller.signal,
        keepalive: true,
      });

      clearTimeout(timeoutId);

      console.log('📊 Fetch response status:', response.status);

      if (response.ok) {
        const data = await response.json();
        
        if (data.success && Array.isArray(data.games)) {
          console.log('✅ Successfully loaded', data.games.length, 'games from API');
          
          // Transform database games to GameOdds format
          const transformedGames: GameOdds[] = data.games.map((g: any) => ({
            id: g.game_id || g.id,
            league: g.league || '',
            homeTeam: g.home_team,
            awayTeam: g.away_team,
            homeOdds: parseFloat(g.home_odds) || 2.0,
            drawOdds: parseFloat(g.draw_odds) || 3.0,
            awayOdds: parseFloat(g.away_odds) || 3.0,
            time: g.scheduled_time || g.time || new Date().toISOString(),
            status: g.status || 'upcoming',
            markets: g.markets || {},
            homeScore: g.home_score || 0,
            awayScore: g.away_score || 0,
            minute: g.minute || 0,
            seconds: 0, // Initialize seconds to 0 - calculated on frontend
            kickoffStartTime: g.kickoff_start_time || undefined,
            isKickoffStarted: g.is_kickoff_started || false,
            gamePaused: g.game_paused || false,
            kickoffPausedAt: g.kickoff_paused_at || undefined,
            isHalftime: g.is_halftime || false,
            sport: g.sport || 'football',
          }));
          
          // Remove duplicates by ID and sort by ID for stable ordering to prevent reranking/collision issues
          const seenIds = new Set<string>();
          const deduplicatedGames = transformedGames.filter(game => {
            if (seenIds.has(game.id)) {
              console.warn(`⚠️ Duplicate game removed: ${game.id} (${game.homeTeam} vs ${game.awayTeam})`);
              return false;
            }
            seenIds.add(game.id);
            return true;
          });
          
          const sortedGames = deduplicatedGames.sort((a, b) => a.id.localeCompare(b.id));
          setGames(sortedGames);
          gamesRef.current = sortedGames;
          // Save to localStorage cache for next page load
          saveCachedGames(sortedGames);
          setLoadError(null);
        } else {
          console.warn('⚠️ Invalid response format:', data);
          setLoadError(null); // Don't show error, just start with empty games
        }
      } else {
        console.warn('⚠️ API returned non-OK status:', response.status);
        setLoadError(null); // Don't block app from loading
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('⏱️ Game fetch timeout (10s)');
      } else {
        console.error('❌ Error fetching games:', error);
      }
      setLoadError(null); // Don't block app from loading
    } finally {
      setIsLoading(false);
      fetchInProgressRef.current = false;
    }
  }, []);

  // Fetch games immediately on mount - this runs before useEffect
  useEffect(() => {
    performFetch();

    // No auto-refresh needed - timer polling handles live game updates
    return () => {
      // Cleanup handled by timer effect
    };
  }, [performFetch]);

  // Timer polling for live games - fetch server time to sync across all users/admin
  useEffect(() => {
    const timerInterval = setInterval(async () => {
      // Find all live games that are in kickoff using the ref (avoids recreating interval)
      const liveGames = gamesRef.current.filter(g => g.isKickoffStarted && (g.status === 'live' || g.minute === undefined));
      
      if (liveGames.length === 0) return; // No live games, skip fetch

      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      const now = Date.now();

      // Separate games into local-calc and backend-fetch groups
      const localGames = [];
      const backendGames = [];

      for (const game of liveGames) {
        const kickoffTime = kickoffTimesRef.current[game.id];
        const timeSinceKickoff = kickoffTime ? now - kickoffTime : -1;
        
        if (kickoffTime && timeSinceKickoff < 2000) {
          // Game just kicked off - use local time
          const elapsedMs = timeSinceKickoff;
          const totalSeconds = Math.floor(elapsedMs / 1000);
          localGames.push({
            gameId: game.id,
            minute: Math.floor(totalSeconds / 60),
            seconds: totalSeconds % 60,
            isHalftime: false,
            gamePaused: false,
            source: 'local'
          });
        } else {
          // After 2 seconds, add to backend fetch list
          backendGames.push(game);
        }
      }

      // ⚡ OPTIMIZATION: Use batch endpoint for multiple games (replaces individual requests)
      // This reduces: 20 games = 20 requests → 1 request (95% reduction)
      let backendResults = [];
      if (backendGames.length > 0) {
        try {
          const gameIds = backendGames.map(g => g.id).join(',');
          const response = await fetch(`${apiUrl}/api/admin/games/times/batch?ids=${encodeURIComponent(gameIds)}`, {
            signal: AbortSignal.timeout(3000),
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.games) {
              backendResults = data.games.map((g: any) => ({
                gameId: g.gameId,
                minute: g.minute ?? 0,
                seconds: g.seconds ?? 0,
                isHalftime: g.isHalftime ?? false,
                gamePaused: g.gamePaused ?? false,
                source: 'batch'
              }));
            }
          }
        } catch (error) {
          console.error('Timer batch fetch failed:', error);
        }
      }

      // Combine local and backend results
      const allResults = [...localGames, ...backendResults];

      // Batch all updates into a single setGames call
      if (allResults.length > 0) {
        setGames(prev => {
          let hasChanges = false;
          const updated = prev.map(g => {
            const timerUpdate = allResults.find(r => r.gameId === g.id);
            if (timerUpdate && (g.minute !== timerUpdate.minute || g.seconds !== timerUpdate.seconds || g.isHalftime !== timerUpdate.isHalftime || g.gamePaused !== timerUpdate.gamePaused)) {
              hasChanges = true;
              return { ...g, minute: timerUpdate.minute, seconds: timerUpdate.seconds, isHalftime: timerUpdate.isHalftime, gamePaused: timerUpdate.gamePaused };
            }
            return g;
          });
          if (!hasChanges) return prev;
          gamesRef.current = updated;
          return updated;
        });
      }
    }, 1000); // Poll every second for live games

    return () => clearInterval(timerInterval);
  }, []); // No dependencies - interval runs once and uses ref for current games

  // ⛔ Live data polling DISABLED — automatic sync from API-Football disabled
  // Admin must manually trigger syncs. This prevents continuous API calls.
  // useEffect(() => {
  //   const syncApiGames = async () => {
  //     if (!hasApiGamesNeedingSync()) return;
  //
  //     const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
  //
  //     try {
  //       // 1. Trigger a server-side sync of scores + odds from API-Football
  //       await fetch(`${apiUrl}/api/live/sync`, { signal: AbortSignal.timeout(15000) });
  //
  //       // 2. Refresh full game list so status transitions (live -> finished)
  //       // are reflected immediately in the UI sections.
  //       await refreshGames();
  //     } catch {
  //       // Silently ignore — live data will try again next cycle
  //     }
  //   };
  //
  //   syncApiGames();
  //   const liveDataInterval = setInterval(syncApiGames, 30000); // Poll every 30 seconds
  //
  //   return () => clearInterval(liveDataInterval);
  // }, []); // No dependencies - uses ref for current games

  // Refresh the full game list periodically so DB-driven status changes
  // (such as scheduled kickoff events) appear for all users without a manual reload.
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      refreshGames();
    }, 15000);

    return () => clearInterval(refreshInterval);
  }, []);

  // Fast market change detection - check for updated games every 2 seconds (faster than before)
  // This ensures admins' market updates appear to all users quickly
  useEffect(() => {
    const marketCheckInterval = setInterval(async () => {
      if (gamesRef.current.length === 0) return;
      
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(`${apiUrl}/api/admin/games`, {
          signal: controller.signal,
          keepalive: true,
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && Array.isArray(data.games)) {
            // Check each game for market changes
            let hasMarketUpdates = false;
            
            for (const newGame of data.games) {
              const gameId = newGame.game_id || newGame.id;
              const currentGame = gamesRef.current.find(g => g.id === gameId);
              
              if (currentGame) {
                // Check if markets have changed (use JSON stringify for deep comparison)
                const newMarketsStr = JSON.stringify((newGame.markets || {}) || {});
                const currentMarketsStr = JSON.stringify((currentGame.markets || {}) || {});
                
                if (newMarketsStr !== currentMarketsStr) {
                  console.log(`📊 [MARKET UPDATE] Market change detected for ${gameId}: ${newGame.home_team} vs ${newGame.away_team}`);
                  console.log(`   Old markets keys: ${Object.keys(currentGame.markets || {}).length}`);
                  console.log(`   New markets keys: ${Object.keys(newGame.markets || {}).length}`);
                  
                  // Log specific market changes for debugging
                  for (const [key, value] of Object.entries(newGame.markets || {})) {
                    const oldValue = currentGame.markets?.[key];
                    if (oldValue !== value) {
                      console.log(`   ${key}: ${oldValue} → ${value}`);
                    }
                  }
                  
                  hasMarketUpdates = true;
                  break; // Found an update, proceed with refresh
                }
              }
            }
            
            // If we detected market changes, refresh the full game list immediately
            if (hasMarketUpdates) {
              console.log('🔄 [MARKET UPDATE] Market changes detected - refreshing games for all users');
              setGames(prev => {
                const transformedGames: GameOdds[] = data.games.map((g: any) => ({
                  id: g.game_id || g.id,
                  league: g.league || '',
                  homeTeam: g.home_team,
                  awayTeam: g.away_team,
                  homeOdds: parseFloat(g.home_odds) || 2.0,
                  drawOdds: parseFloat(g.draw_odds) || 3.0,
                  awayOdds: parseFloat(g.away_odds) || 3.0,
                  time: g.scheduled_time || g.time || new Date().toISOString(),
                  status: g.status || 'upcoming',
                  markets: g.markets || {},
                  homeScore: g.home_score || 0,
                  awayScore: g.away_score || 0,
                  minute: g.minute || 0,
                  seconds: 0,
                  kickoffStartTime: g.kickoff_start_time || undefined,
                  isKickoffStarted: g.is_kickoff_started || false,
                  gamePaused: g.game_paused || false,
                  kickoffPausedAt: g.kickoff_paused_at || undefined,
                  isHalftime: g.is_halftime || false,
                  isHot: g.is_hot || false,
                }));
                
                const seenIds = new Set<string>();
                const deduplicatedGames = transformedGames.filter(game => {
                  if (seenIds.has(game.id)) return false;
                  seenIds.add(game.id);
                  return true;
                });
                
                const sortedGames = deduplicatedGames.sort((a, b) => a.id.localeCompare(b.id));
                console.log(`✅ [MARKET UPDATE] Updated ${sortedGames.length} games with new market data`);
                gamesRef.current = sortedGames;
                // Save to localStorage cache after market updates
                saveCachedGames(sortedGames);
                return sortedGames;
              });
            }
          }
        }
      } catch (error) {
        // Silently ignore market check errors
      }
    }, 2000); // Check every 2 seconds for market changes (faster detection)
    
    return () => clearInterval(marketCheckInterval);
  }, []);

  // ⛔ Daily schedule maintenance DISABLED — automatic bootstrap-schedule fetch removed
  // useEffect(() => {
  //   const ensureSchedule = async () => {
  //     const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
  //     try {
  //       const resp = await fetch(`${apiUrl}/api/live/bootstrap-schedule`, {
  //         signal: AbortSignal.timeout(45000),
  //       });
  //       if (!resp.ok) return;
  //       const data = await resp.json();
  //       if (data?.success && data?.refreshed) {
  //         await refreshGames();
  //       }
  //     } catch {
  //       // Silent retry on next interval
  //     }
  //   };
  //
  //   const scheduleInterval = setInterval(ensureSchedule, 10 * 60 * 1000);
  //   return () => clearInterval(scheduleInterval);
  // }, []);

  const refreshGames = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexarevivebackend.vercel.app';
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 second timeout

      const response = await fetch(`${apiUrl}/api/admin/games`, {
        signal: controller.signal,
        keepalive: true,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.games)) {
          // Transform database games to GameOdds format
          const transformedGames: GameOdds[] = data.games.map((g: any) => ({
            id: g.game_id || g.id,
            league: g.league || '',
            homeTeam: g.home_team,
            awayTeam: g.away_team,
            homeOdds: parseFloat(g.home_odds) || 2.0,
            drawOdds: parseFloat(g.draw_odds) || 3.0,
            awayOdds: parseFloat(g.away_odds) || 3.0,
            time: g.scheduled_time || g.time || new Date().toISOString(),
            status: g.status || 'upcoming',
            markets: g.markets || {},
            homeScore: g.home_score || 0,
            awayScore: g.away_score || 0,
            minute: g.minute || 0,
            seconds: 0, // Initialize seconds to 0 - calculated on frontend
            kickoffStartTime: g.kickoff_start_time || undefined,
            isKickoffStarted: g.is_kickoff_started || false,
            gamePaused: g.game_paused || false,
            kickoffPausedAt: g.kickoff_paused_at || undefined,
            isHalftime: g.is_halftime || false,
            isHot: g.is_hot || false,
          }));
          
          // Remove duplicates by ID and sort by ID for stable ordering to prevent reranking/collision issues
          const seenIds = new Set<string>();
          const deduplicatedGames = transformedGames.filter(game => {
            if (seenIds.has(game.id)) {
              console.warn(`⚠️ Duplicate game removed in refresh: ${game.id} (${game.homeTeam} vs ${game.awayTeam})`);
              return false;
            }
            seenIds.add(game.id);
            return true;
          });
          
          const sortedGames = deduplicatedGames.sort((a, b) => a.id.localeCompare(b.id));
          setGames(sortedGames);
          gamesRef.current = sortedGames;
          // Save to localStorage cache for next page load
          saveCachedGames(sortedGames);
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('⏱️ Game refresh timeout (10s)');
      } else {
        console.error('❌ Error refreshing games:', error);
      }
    }
  };

  const addGame = (game: GameOdds) => {
    setGames((prev) => {
      // Check for duplicates by ID
      if (prev.some(g => g.id === game.id)) {
        console.warn(`⚠️ Duplicate game detected with ID ${game.id}, skipping add`);
        return prev;
      }
      // Add new game and maintain stable sort by ID
      const updated = [...prev, game].sort((a, b) => a.id.localeCompare(b.id));
      gamesRef.current = updated;
      // Save to cache after adding game
      saveCachedGames(updated);
      return updated;
    });
  };

  const updateGame = (id: string, updates: Partial<GameOdds>) => {
    setGames((prev) => {
      const updated = prev.map((game) => {
        if (game.id === id) {
          const newGame = { ...game, ...updates };
          // Track when game was kicked off
          if (!game.isKickoffStarted && newGame.isKickoffStarted) {
            kickoffTimesRef.current[id] = Date.now();
            console.log(`⏱️ [KICKOFF] Game ${id} started at ${new Date(kickoffTimesRef.current[id]).toISOString()}`);
          }
          return newGame;
        }
        return game;
      });
      // Maintain stable sort order by ID to prevent reranking issues
      const stableSorted = updated.sort((a, b) => a.id.localeCompare(b.id));
      gamesRef.current = stableSorted;
      // Save to cache after updating game
      saveCachedGames(stableSorted);
      return stableSorted;
    });
  };

  const removeGame = (id: string) => {
    setGames((prev) => {
      const updated = prev.filter((game) => game.id !== id);
      gamesRef.current = updated;
      // Save to cache after removing game
      saveCachedGames(updated);
      return updated;
    });
  };

  const getGame = (id: string) => {
    return games.find((game) => game.id === id);
  };

  const updateGameMarkets = (id: string, markets: Record<string, number>) => {
    updateGame(id, { markets });
  };

  return (
    <OddsContext.Provider
      value={{ games, isLoading, addGame, updateGame, removeGame, getGame, updateGameMarkets, refreshGames }}
    >
      {children}
    </OddsContext.Provider>
  );
}

export function useOdds() {
  const context = useContext(OddsContext);
  if (context === undefined) {
    throw new Error("useOdds must be used within an OddsProvider");
  }
  return context;
}


