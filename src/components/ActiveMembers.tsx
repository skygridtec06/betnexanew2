import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Users, Dot, RefreshCw } from "lucide-react";
import { usePresence } from "@/context/PresenceContext";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUserManagement } from "@/context/UserManagementContext";

interface UserPresence {
  id: string;
  user_id: string;
  session_id: string;
  last_activity: string;
  login_time: string;
  status: 'online' | 'idle' | 'offline';
  users?: {
    id: string;
    username: string;
    phone_number: string;
    phone?: string;
    email: string;
    total_bets: number;
    total_winnings: number;
    account_balance: number;
  };
}

export function ActiveMembers() {
  const { activeUsers, activeCount } = usePresence();
  const { users } = useUserManagement();
  const [isOpen, setIsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${apiUrl}/api/presence/active`, {
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      console.log('âœ… Active members refreshed:', data);
    } catch (error) {
      console.error('âŒ Error refreshing members:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const activeMembers = useMemo(() => {
    const sorted = [...activeUsers].sort(
      (a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
    );
    const seenUserIds = new Set<string>();

    return sorted.flatMap((presence: UserPresence) => {
      const uniqueKey = String(presence.user_id || presence.users?.id || presence.session_id || '');
      if (!uniqueKey || seenUserIds.has(uniqueKey)) {
        return [];
      }
      seenUserIds.add(uniqueKey);

      const cachedUser = Array.isArray(users)
        ? users.find((user: any) => user.id === presence.user_id)
        : undefined;
      const username = presence.users?.username || cachedUser?.username || cachedUser?.name || "Unknown";
      const phoneNumber = presence.users?.phone_number || presence.users?.phone || cachedUser?.phone || "N/A";

      return [{
        sessionId: uniqueKey,
        username,
        phoneNumber,
      }];
    }
    );
  }, [activeUsers, users]);

  return (
    <>
      <div className="gradient-card rounded-xl border border-border/50 p-5 card-glow hover:border-primary/50 transition-colors">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Online</p>
            <p className="mt-1 font-display text-2xl font-bold text-green-500">{activeCount}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Active on the site or running in background</p>
          </div>
          <div className="relative">
            <Users className="h-8 w-8 text-green-500 opacity-30" />
            <Dot className="absolute top-0 right-0 h-4 w-4 text-green-500 animate-pulse" />
          </div>
        </div>
        <Button variant="outline" size="sm" className="mt-4 w-full" onClick={() => setIsOpen(true)}>
          Show Online
        </Button>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-lg max-h-96 overflow-hidden flex flex-col bg-card border-border">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl font-bold text-foreground flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Online Users
              </DialogTitle>
              <DialogDescription className="mt-1">
                {activeCount} user{activeCount !== 1 ? 's' : ''} active right now. Users appear and disappear in real time.
              </DialogDescription>
            </div>
            <Button 
              size="sm" 
              variant="outline" 
              onClick={handleRefresh}
              disabled={refreshing}
              className="gap-1"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
          {activeMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="h-12 w-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">No users currently online</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeMembers.map((member) => {
                return (
                  <div key={member.sessionId} className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 p-3 transition-colors hover:bg-secondary/70">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Dot className="h-3 w-3 text-green-500 animate-pulse flex-shrink-0" />
                        <p className="font-semibold text-sm text-foreground truncate">
                          {member.username}
                        </p>
                        <Badge variant="outline" className="text-xs ml-auto flex-shrink-0">
                          Online
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{member.phoneNumber}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
      </Dialog>
    </>
  );
}
