import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Trash2, ChevronUp, ChevronDown, CheckCircle, Copy, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useBets } from "@/context/BetContext";
import { useUser } from "@/context/UserContext";
import { generateShareableLink } from "@/lib/shareableLinks";
import type { PlacedBet } from "@/context/BetContext";

export interface BetSlipItem {
  matchId: string;
  match: string;
  type: string;
  market: string;
  odds: number;
}

export function getMarketName(market: string): string {
  const marketMap: Record<string, string> = {
    '1X2': '1X2',
    'BTTS': 'Both Teams To Score',
    'O/U': 'Over/Under',
    'DC': 'Double Chance',
    'HT/FT': 'Half Time/Full Time',
    'CS': 'Correct Score',
  };
  return marketMap[market] || market;
}

export function getPickLabel(type: string): string {
  const lowerType = type.toLowerCase();
  
  // Correct Score: cs31 OR CS31 OR cs-31 OR CS-31 -> returns 3:1
  if (lowerType.startsWith('cs')) {
    let scoreStr = '';
    if (lowerType.includes('-')) {
      scoreStr = lowerType.replace('cs-', '').replace('-', '');
    } else {
      scoreStr = lowerType.substring(2);
    }
    if (scoreStr && scoreStr.length >= 2) {
      const digits = scoreStr.match(/\d/g);
      if (digits && digits.length >= 2) {
        return `${digits[0]}:${digits[1]}`;
      }
    }
  }
  
  // BTTS: Handle both bttsYes and btts-yes formats
  if (lowerType === 'bttsyes' || lowerType === 'btts-yes' || lowerType === 'bttsyes') return 'YES';
  if (lowerType === 'bttsno' || lowerType === 'btts-no' || lowerType === 'bttsno') return 'NO';
  
  // 1X2
  if (type === 'home') return 'Home Win';
  if (type === 'draw') return 'Draw';
  if (type === 'away') return 'Away Win';
  
  // Double Chance: Handle multiple formats and return short codes
  // 1X = Home/Draw (home win or draw)
  if (lowerType === 'dchomedordraw' || lowerType === 'doubleChanceHomeOrDraw' || lowerType === 'dc-hd' || lowerType === 'dc-1x') return '1X';
  // X2 = Draw/Away (draw or away win)
  if (lowerType === 'dcawayordraw' || lowerType === 'doubleChanceAwayOrDraw' || lowerType === 'dc-ad' || lowerType === 'dc-x2') return 'X2';
  // 12 = Home/Away (any win, not draw)
  if (lowerType === 'dchomeoraway' || lowerType === 'doubleChanceHomeOrAway' || lowerType === 'dc-ha' || lowerType === 'dc-12') return '12';

  // Over/Under
  if (type === 'over25') return 'Over 2.5';
  if (type === 'under25') return 'Under 2.5';
  if (type === 'over15') return 'Over 1.5';
  if (type === 'under15') return 'Under 1.5';
  
  // Double Chance
  if (type === 'dcHomeOrDraw') return 'Home/Draw';
  if (type === 'doubleChanceHomeOrDraw') return 'Home/Draw';
  if (type === 'dcAwayOrDraw') return 'Away/Draw';
  if (type === 'doubleChanceAwayOrDraw') return 'Away/Draw';
  if (type === 'dcHomeOrAway') return 'Home/Away';
  if (type === 'doubleChanceHomeOrAway') return 'Home/Away';
  
  // Half Time/Full Time
  if (type === 'htftHomeHome') return 'Home/Home';
  if (type === 'htftDrawDraw') return 'Draw/Draw';
  if (type === 'htftAwayAway') return 'Away/Away';
  if (type === 'htftDrawHome') return 'Draw/Home';
  if (type === 'htftDrawAway') return 'Draw/Away';
  if (type === 'htftHomeAway') return 'Home/Away';
  if (type === 'htftAwayHome') return 'Away/Home';
  
  return type;
}

interface BettingSlipProps {
  items: BetSlipItem[];
  onRemove: (matchId: string) => void;
  onClear: () => void;
}

export function BettingSlip({ items, onRemove, onClear }: BettingSlipProps) {
  const [stake, setStake] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const [isPlacing, setIsPlacing] = useState(false);
  const { addBet, placeBet, syncBalance } = useBets();
  const { user, isLoggedIn } = useUser();
  const navigate = useNavigate();

  const stakeNum = parseFloat(stake) || 0;
  const totalOdds = items.reduce((acc, item) => acc * item.odds, 1);
  const potentialWin = stakeNum * totalOdds;

  const generateBetId = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  const handlePlaceBet = async () => {
    // Check if user is logged in
    if (!isLoggedIn) {
      // Store picks in sessionStorage for persistence through signup flow
      try {
        const params = new URLSearchParams(window.location.search);
        const picks = params.get("picks");
        if (picks) {
          sessionStorage.setItem("pendingPicks", picks);
        }
      } catch (error) {
        console.error("Failed to store pending picks:", error);
      }
      
      toast({
        title: "Sign Up to Place Bet",
        description: "Please sign up or login to place bets.",
        variant: "default",
      });
      navigate("/signup");
      return;
    }

    if (stakeNum < 500) {
      toast({
        title: "Invalid Stake",
        description: "Minimum stake amount is KSH 500",
        variant: "destructive",
      });
      return;
    }

    if (!user?.phone) {
      toast({
        title: "Error",
        description: "User information not found. Please login again.",
        variant: "destructive",
      });
      return;
    }

    setIsPlacing(true);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexanewbackend.vercel.app';
      
      // Call backend to place bet and deduct balance
      const response = await fetch(`${apiUrl}/api/bets/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          phoneNumber: user.phone,
          stake: stakeNum,
          potentialWin: Math.round(potentialWin),
          totalOdds: Number(totalOdds.toFixed(2)),
          selections: items
        })
      });

      const data = await response.json();

      if (!data.success) {
        toast({
          title: "Bet Failed",
          description: data.error || 'Failed to place bet',
          variant: "destructive",
        });
        setIsPlacing(false);
        return;
      }

      // Update local balance with new balance from server
      if (data.newBalance !== undefined) {
        syncBalance(data.newBalance);
      }

      // Add bet to local context
      const now = new Date();
      const newBet: PlacedBet = {
        id: data.bet.id,  // Use actual database UUID
        betId: data.bet.betId,
        date: `${now.getDate()}/${now.getMonth() + 1}`,
        time: `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`,
        stake: stakeNum,
        potentialWin: Math.round(potentialWin),
        totalOdds: Number(totalOdds.toFixed(2)),
        selections: items,
        status: "Open",
      };

      addBet(newBet);

      toast({
        title: "Bet Placed Successfully! ðŸŽ‰",
        description: `BetID: ${data.bet.betId} | KSH ${stakeNum.toFixed(2)} on ${items.length} selection${items.length > 1 ? "s" : ""} - Potential win: KSH ${potentialWin.toFixed(2)}`,
      });

      // Keep selections on slip; user can remove or clear manually.
      setStake("");
      setIsPlacing(false);
      setIsOpen(true);
    } catch (error) {
      console.error('Error placing bet:', error);
      toast({
        title: "Error",
        description: "Failed to place bet. Please try again.",
        variant: "destructive",
      });
      setIsPlacing(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 sm:left-auto z-40 w-auto sm:w-80 animate-slide-in rounded-t-xl border border-border bg-card shadow-2xl">
      {/* Header */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-t-xl bg-primary px-4 py-3"
      >
        <span className="font-display text-sm font-bold text-primary-foreground">
          Bet Slip ({items.length})
        </span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-primary-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-primary-foreground" />
        )}
      </button>

      {isOpen && (
        <div className="max-h-72 overflow-y-auto p-4">
          {/* Items */}
          {items.map((item) => (
            <div key={item.matchId} className="mb-3 flex items-start justify-between rounded-lg bg-secondary p-3">
              <div>
                <p className="text-xs font-medium text-foreground">{item.match}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.market === 'CS' ? 'CORRECT SCORE' : item.market === 'O/U' ? 'OVER/UNDER' : item.market === 'HT/FT' ? 'HALF TIME/FULL TIME' : item.market === 'DC' ? 'DOUBLE CHANCE' : item.market === 'BTTS' ? 'BOTH TEAMS TO SCORE' : item.market} - <span className="font-semibold text-primary">{getPickLabel(item.type)}</span> â€” <span className="font-mono font-bold text-primary">{item.odds.toFixed(2)}</span>
                </p>
              </div>
              <button onClick={() => onRemove(item.matchId)} className="text-muted-foreground hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {/* Stake */}
          <div className="mt-3">
            <label className="mb-1 block text-xs text-muted-foreground">Stake (KSH)</label>
            <input
              type="number"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
          </div>

          {/* Summary */}
          <div className="mt-3 space-y-1 border-t border-border pt-3">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Total Odds</span>
              <span className="font-mono font-bold text-foreground">{totalOdds.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="font-medium text-foreground">Potential Win</span>
              <span className="font-mono font-bold text-primary">KSH {potentialWin.toFixed(2)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClear} className="flex-1 text-xs" disabled={isPlacing}>
              <Trash2 className="mr-1 h-3 w-3" /> Clear
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              className="flex-1 text-xs"
              onClick={async () => {
                try {
                  const link = await generateShareableLink(items);
                  if (!link) {
                    toast({
                      title: "Error",
                      description: "Failed to generate share link. Please try again.",
                      variant: "destructive",
                    });
                    return;
                  }
                  navigator.clipboard.writeText(link);
                  toast({
                    title: "Link Copied!",
                    description: `Share this link: ${link}`,
                  });
                } catch (error) {
                  console.error("Failed to copy link:", error);
                  toast({
                    title: "Error",
                    description: "Failed to copy link. Please try again.",
                    variant: "destructive",
                  });
                }
              }}
              disabled={items.length === 0}
            >
              <LinkIcon className="mr-1 h-3 w-3" /> Share
            </Button>
            <Button 
              variant="hero" 
              size="sm" 
              className={`flex-1 text-xs ${user?.isAdmin ? '' : 'flex-1'}`}
              onClick={handlePlaceBet}
              disabled={isPlacing || items.length === 0}
            >
              {isPlacing ? (
                <>
                  <span className="animate-spin mr-1 inline-block">â³</span> Placing...
                </>
              ) : (
                <>
                  <CheckCircle className="mr-1 h-3 w-3" /> Place Bet
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}




