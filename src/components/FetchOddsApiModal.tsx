import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Globe, CheckCircle, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface GamePreview {
  api_fixture_id: string;
  league: string;
  home_team: string;
  away_team: string;
  home_odds: number;
  draw_odds: number;
  away_odds: number;
  time_utc: string;
  time_eat: string;
  markets: Record<string, number>;
}

interface FetchOddsApiModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExecute: (games: GamePreview[]) => Promise<void>;
}

export const FetchOddsApiModal = ({ isOpen, onClose, onExecute }: FetchOddsApiModalProps) => {
  const [step, setStep] = useState<'idle' | 'fetching' | 'preview' | 'executing' | 'complete' | 'error'>('idle');
  const [games, setGames] = useState<GamePreview[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const handleFetch = async () => {
    setStep('fetching');
    setErrorMsg('');
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const adminPhone = localStorage.getItem("adminPhone") || localStorage.getItem("userPhone") || "0712345678";

      const response = await fetch(`${apiUrl}/api/admin/fetch-odds-api/fetch-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: adminPhone })
      });

      const data = await response.json();

      if (!data.success) {
        setErrorMsg(data.error || 'Failed to fetch matches');
        setStep('error');
        return;
      }

      setGames(data.games || []);
      setStep('preview');
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Fetch failed');
      setStep('error');
    }
  };

  const handleExecute = async () => {
    setStep('executing');
    try {
      await onExecute(games);
      setStep('complete');
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Execute failed');
      setStep('error');
    }
  };

  const handleClose = () => {
    setStep('idle');
    setGames([]);
    setErrorMsg('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" />
            Add Matches from The Odds API
          </DialogTitle>
          <DialogDescription>
            Fetch upcoming soccer fixtures and odds from The Odds API across all major leagues, covering 1X2, BTTS, Over/Under, HT/FT and Correct Score markets.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {step === 'idle' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Click below to scan the top soccer competitions for upcoming fixtures with accurate odds
                for 1X2, BTTS, Over/Under, HT/FT and Correct Score. Matches automatically drop off the
                Upcoming tab once their kickoff time arrives.
              </p>
              <Button onClick={handleFetch} className="w-full" size="lg">
                <Globe className="w-4 h-4 mr-2" />
                Fetch Matches from The Odds API
              </Button>
            </div>
          )}

          {step === 'fetching' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p>Scanning leagues on The Odds API...</p>
              <p className="text-xs text-muted-foreground">Fetching fixtures and market odds, this can take a moment</p>
            </div>
          )}

          {step === 'preview' && games.length > 0 && (
            <div className="space-y-4">
              <div className="bg-blue-500/10 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-lg font-semibold text-blue-700 dark:text-blue-300">
                  ✅ Fetched {games.length} matches
                </p>
                <p className="text-sm text-blue-600 dark:text-blue-400 mt-2">
                  Click Execute below to add these {games.length} matches to the site.
                </p>
              </div>

              <div className="max-h-[400px] overflow-y-auto space-y-2">
                {games.map((game, i) => (
                  <Card key={i} className="p-3 bg-card/50">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {game.home_team} vs {game.away_team}
                        </p>
                        <p className="text-xs text-muted-foreground">{game.league}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className="text-xs font-mono">
                            {game.home_odds} - {game.draw_odds} - {game.away_odds}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(game.time_eat).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'Africa/Nairobi'
                            })} EAT
                          </p>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <div className="flex gap-3 pt-4">
                <Button onClick={() => setStep('idle')} variant="outline" className="flex-1">
                  Back
                </Button>
                <Button onClick={handleExecute} className="flex-1" size="lg">
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Execute: Add {games.length} Matches
                </Button>
              </div>
            </div>
          )}

          {step === 'preview' && games.length === 0 && (
            <div className="space-y-4">
              <div className="bg-yellow-500/10 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <p className="text-lg font-semibold text-yellow-700 dark:text-yellow-300">
                  ℹ️ No matches found
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  No upcoming fixtures with valid odds were found. Try again shortly.
                </p>
              </div>
              <div className="flex gap-3">
                <Button onClick={() => setStep('idle')} variant="outline" className="flex-1">
                  Try Again
                </Button>
                <Button onClick={handleClose} className="flex-1">
                  Close
                </Button>
              </div>
            </div>
          )}

          {step === 'executing' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p>Adding {games.length} matches to the site...</p>
            </div>
          )}

          {step === 'complete' && (
            <div className="space-y-4">
              <div className="bg-green-500/10 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-lg font-semibold text-green-700 dark:text-green-300 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5" />
                  Success! Added {games.length} matches
                </p>
              </div>
              <Button onClick={handleClose} className="w-full">
                Close
              </Button>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-4">
              <div className="bg-red-500/10 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-lg font-semibold text-red-700 dark:text-red-300 flex items-center gap-2">
                  <AlertCircle className="w-5 h-5" />
                  Error
                </p>
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">{errorMsg}</p>
              </div>
              <div className="flex gap-3">
                <Button onClick={() => setStep('idle')} variant="outline" className="flex-1">
                  Try Again
                </Button>
                <Button onClick={handleClose} className="flex-1">
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
