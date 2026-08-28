import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Plus, Trash2, CheckCircle, XCircle, Clock, DollarSign, Users, UserPlus, BarChart3, Trophy, Settings, RefreshCw, Edit2, Save, ArrowDown, ArrowUp, Play, Pause, Square, Lock, Unlock, Shield, Zap, Upload, Image as ImageIcon, Loader2, Megaphone, Calendar, Download, Ban, Flame, ArrowRightLeft } from "lucide-react";
import { type MatchMarkets } from "@/components/MatchCard";
import { useMatches } from "@/context/MatchContext";
import { useBets, type PlacedBet } from "@/context/BetContext";
import { useOdds, type GameOdds } from "@/context/OddsContext";
import { useUserManagement } from "@/context/UserManagementContext";
import { useUser } from "@/context/UserContext";
import { useTransactions } from "@/context/TransactionContext";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { calculateMatchMinute } from "@/lib/gameTimeCalculator";
import balanceSyncService from "@/lib/balanceSyncService";
import { formatDateInEAT, formatTransactionDateInEAT, formatTimeInEAT } from "@/lib/timezoneFormatter";
import { MatchEventEditor } from "@/components/MatchEventEditor";
import { ActiveMembers } from "@/components/ActiveMembers";
import { FetchGamesFetchModal } from "@/components/FetchGamesFetchModal";
import { EarningsCalculator } from "@/components/EarningsCalculator";

const marketLabels: Record<string, string> = {
  bttsYes: "BTTS Yes", bttsNo: "BTTS No",
  over25: "Over 2.5", under25: "Under 2.5", over15: "Over 1.5", under15: "Under 1.5",
  doubleChanceHomeOrDraw: "DC 1X", doubleChanceAwayOrDraw: "DC X2", doubleChanceHomeOrAway: "DC 12",
  htftHomeHome: "HT/FT H/H", htftDrawDraw: "HT/FT D/D", htftAwayAway: "HT/FT A/A", htftDrawHome: "HT/FT D/H", htftDrawAway: "HT/FT D/A",
  cs10: "CS 1-0", cs20: "CS 2-0", cs11: "CS 1-1", cs00: "CS 0-0", cs01: "CS 0-1", cs21: "CS 2-1", cs12: "CS 1-2", cs02: "CS 0-2",
  cs22: "CS 2-2",
  cs30: "CS 3-0", cs03: "CS 0-3", cs31: "CS 3-1", cs13: "CS 1-3", cs32: "CS 3-2", cs23: "CS 2-3", cs40: "CS 4-0", cs04: "CS 0-4",
  cs33: "CS 3-3",
  cs41: "CS 4-1", cs14: "CS 1-4", cs42: "CS 4-2", cs24: "CS 2-4", cs43: "CS 4-3", cs34: "CS 3-4", cs44: "CS 4-4",
};

// Helper function to sort games by upcoming kickoff time (closest first)
const sortGamesByKickoffTime = (gamesToSort: any[]) => {
  return [...gamesToSort].sort((a, b) => {
    try {
      // First, prioritize admin-added matches over API-fetched matches
      // API-managed games have game_id starting with 'af-' (from backend isApiManagedGameId check)
      const isApiManagedA = a.game_id && String(a.game_id).startsWith('af-');
      const isApiManagedB = b.game_id && String(b.game_id).startsWith('af-');
      const isAdminAddedA = !isApiManagedA;  // Admin-added if NOT API-managed
      const isAdminAddedB = !isApiManagedB;
      
      // Debug: Log first few games to verify sorting
      if (gamesToSort.length > 0 && gamesToSort.indexOf(a) < 2) {
        console.log(`[SORT] ${a.game_id || 'no-id'} (${a.homeTeam}) - isAdminAdded=${isAdminAddedA}, isApiManaged=${isApiManagedA}`);
      }
      
      if (isAdminAddedA && !isAdminAddedB) {
        return -1; // Admin-added match A comes first
      } else if (!isAdminAddedA && isAdminAddedB) {
        return 1; // Admin-added match B comes first
      }
      
      // Then, prioritize by status: live > upcoming > finished
      const statusPriority = { live: 0, upcoming: 1, finished: 2 };
      const priorityA = statusPriority[a.status as keyof typeof statusPriority] ?? 3;
      const priorityB = statusPriority[b.status as keyof typeof statusPriority] ?? 3;
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB; // Live games first, then upcoming, then finished
      }
      
      // Within the same status group, sort by time
      const timeA = new Date(a.time).getTime();
      const timeB = new Date(b.time).getTime();
      
      // For upcoming/live games, show closest to kickoff first (ascending time)
      // For finished games, show most recent first (descending time)
      if (a.status === "finished") {
        return timeB - timeA; // Most recent finished games first
      } else {
        return timeA - timeB; // Upcoming/live games with closest kickoff first
      }
    } catch (e) {
      return 0; // If time parsing fails, maintain order
    }
  });
};

const AdminPortal = () => {
  const { matches, updateScore, setFinalScore } = useMatches();
  const { bets, syncBalance, updateBetStatus, fetchAllBets, setBets } = useBets();
  const { games, addGame, updateGame, removeGame, updateGameMarkets, refreshGames } = useOdds();
  const { users, updateUser, getAllUsers, fetchUsersFromBackend } = useUserManagement();
  const { user: loggedInUser, updateUser: updateCurrentUser } = useUser();
  const { updateTransactionStatus } = useTransactions();
  
  const [showAddGame, setShowAddGame] = useState(false);
  const [showDarajaTestModal, setShowDarajaTestModal] = useState(false);
  const [showFetchGamesModal, setShowFetchGamesModal] = useState(false);
  const [showBetDetailsDialog, setShowBetDetailsDialog] = useState(false);
  const [selectedBetDetails, setSelectedBetDetails] = useState<PlacedBet | null>(null);
  const [adminTab, setAdminTab] = useState("games");
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [pendingTab, setPendingTab] = useState("");
  const [unlockedTabs, setUnlockedTabs] = useState<Set<string>>(new Set());

  const PIN_PROTECTED_TABS = ["earnings", "transactions"];
  const ADMIN_PIN_HASH = "140702";

  const handleTabChange = (tab: string) => {
    if (PIN_PROTECTED_TABS.includes(tab) && !unlockedTabs.has(tab)) {
      setPendingTab(tab);
      setPinInput("");
      setPinError("");
      setShowPinDialog(true);
    } else {
      setAdminTab(tab);
    }
  };

  const handlePinSubmit = () => {
    if (pinInput === ADMIN_PIN_HASH) {
      setUnlockedTabs(prev => new Set([...prev, pendingTab]));
      setAdminTab(pendingTab);
      setShowPinDialog(false);
      setPinInput("");
      setPinError("");
    } else {
      setPinError("Incorrect PIN. Access denied.");
      setPinInput("");
    }
  };

  const openBetDetails = (bet: PlacedBet) => {
    setSelectedBetDetails(bet);
    setShowBetDetailsDialog(true);
  };

  const closeBetDetails = () => {
    setSelectedBetDetails(null);
    setShowBetDetailsDialog(false);
  };

  const openManualTransactionDialog = (user: any) => {
    setManualTransactionUser(user);
    setManualTransactionForm({
      type: 'deposit',
      amount: '',
      status: 'completed',
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toTimeString().slice(0, 5),
      phoneNumber: user?.phone || '',
      description: '',
      method: 'manual-adjustment',
      notes: '',
    });
    setShowManualTransactionDialog(true);
  };

  const handleManualTransactionSubmit = async () => {
    if (!manualTransactionUser) return;

    const amount = Number(manualTransactionForm.amount);
    if (!manualTransactionUser?.id || !Number.isFinite(amount) || amount <= 0) {
      alert('Please enter a valid amount greater than zero.');
      return;
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/transactions/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser?.phone || manualTransactionForm.phoneNumber || manualTransactionUser.phone,
          userId: manualTransactionUser.id,
          type: manualTransactionForm.type,
          amount,
          status: manualTransactionForm.status,
          date: manualTransactionForm.date,
          time: manualTransactionForm.time,
          phoneNumber: manualTransactionForm.phoneNumber || manualTransactionUser.phone,
          description: manualTransactionForm.description || `${manualTransactionForm.type.charAt(0).toUpperCase() + manualTransactionForm.type.slice(1)} inserted by admin`,
          method: manualTransactionForm.method,
          notes: manualTransactionForm.notes,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to insert transaction');
      }

      if (data.user?.account_balance !== undefined) {
        updateUser(manualTransactionUser.id, { accountBalance: Number(data.user.account_balance) || 0 });
      }

      setShowManualTransactionDialog(false);
      setManualTransactionUser(null);
      setManualTransactionForm({
        type: 'deposit',
        amount: '',
        status: 'completed',
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toTimeString().slice(0, 5),
        phoneNumber: '',
        description: '',
        method: 'manual-adjustment',
        notes: '',
      });

      alert(`✅ Manual ${manualTransactionForm.type} transaction inserted for ${manualTransactionUser.name}.`);
    } catch (error) {
      console.error('Failed to insert manual transaction:', error);
      alert(error instanceof Error ? error.message : 'Failed to insert transaction');
    }
  };

  const getSelectionMarketName = (market: string) => {
    if (!market) return "Unknown Market";
    if (marketLabels[market]) return marketLabels[market];
    switch (market) {
      case "CS": return "CORRECT SCORE";
      case "O/U": return "OVER/UNDER";
      case "DC": return "DOUBLE CHANCE";
      case "HT/FT": return "HALF TIME/FULL TIME";
      case "BTTS": return "BOTH TEAMS TO SCORE";
      case "1X2": return "1X2";
      default:
        return market.replace(/_/g, " ").toUpperCase();
    }
  };

  const getSelectionPickLabel = (type: string) => {
    if (!type) return "Unknown Pick";
    const normalized = type.toString();
    switch (normalized) {
      case "bttsYes": return "Yes";
      case "bttsNo": return "No";
      case "home": return "Home";
      case "away": return "Away";
      case "draw": return "Draw";
      default:
        return normalized.replace(/_/g, " ").toUpperCase();
    }
  };
  const [selectedGameForEvents, setSelectedGameForEvents] = useState<{
    id: string;
    name: string;
    kickoffTime: string;
  } | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingUserData, setEditingUserData] = useState<Record<string, any>>({});
  const [showUserTransactionsDialog, setShowUserTransactionsDialog] = useState(false);
  const [selectedTransactionUser, setSelectedTransactionUser] = useState<any>(null);
  const [showManualTransactionDialog, setShowManualTransactionDialog] = useState(false);
  const [manualTransactionUser, setManualTransactionUser] = useState<any>(null);
  const [manualTransactionForm, setManualTransactionForm] = useState({
    type: 'deposit',
    amount: '',
    status: 'completed',
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toTimeString().slice(0, 5),
    phoneNumber: '',
    description: '',
    method: 'manual-adjustment',
    notes: '',
  });
  const [transactionActionInProgress, setTransactionActionInProgress] = useState<string | null>(null);
  const [userTransactionsLoading, setUserTransactionsLoading] = useState(false);
  const [newGame, setNewGame] = useState<{
    league: string;
    homeTeam: string;
    awayTeam: string;
    homeOdds: string;
    drawOdds: string;
    awayOdds: string;
    time: string;
    kickoffDateTime: string;
    status: "upcoming" | "live" | "finished";
    markets: Record<string, string>;
  }>({
    league: "",
    homeTeam: "",
    awayTeam: "",
    homeOdds: "",
    drawOdds: "",
    awayOdds: "",
    time: "",
    kickoffDateTime: "",
    status: "upcoming",
    markets: {
      bttsYes: "",
      bttsNo: "",
      over25: "",
      under25: "",
      over15: "",
      under15: "",
      doubleChanceHomeOrDraw: "",
      doubleChanceAwayOrDraw: "",
      doubleChanceHomeOrAway: "",
      htftHomeHome: "",
      htftDrawDraw: "",
      htftAwayAway: "",
      htftDrawHome: "",
      htftDrawAway: "",
      cs10: "",
      cs20: "",
      cs11: "",
      cs00: "",
      cs01: "",
      cs21: "",
      cs12: "",
      cs02: "",
      cs22: "",
      cs30: "",
      cs03: "",
      cs31: "",
      cs13: "",
      cs32: "",
      cs23: "",
      cs40: "",
      cs04: "",
      cs33: "",
      cs41: "",
      cs14: "",
      cs42: "",
      cs24: "",
      cs43: "",
      cs34: "",
      cs44: ""
    }
  });
  const [scoreUpdate, setScoreUpdate] = useState<Record<string, { home: number; away: number }>>({});
  const [selectionOutcomes, setSelectionOutcomes] = useState<Record<string, Record<number, "won" | "lost">>>({});
  const [sendingBetSmsId, setSendingBetSmsId] = useState<string | null>(null);
  const [smsTriggeredBets, setSmsTriggeredBets] = useState<Record<string, boolean>>({});

  // Fetch SMS-triggered bet IDs from server on load
  useEffect(() => {
    const fetchServerBetFlags = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
        const adminPhone = localStorage.getItem("adminPhone") || localStorage.getItem("userPhone") || "0712345678";
        const smsResp = await fetch(`${apiUrl}/api/admin/bets/sms-triggered?phone=${adminPhone}`);
        const smsData = await smsResp.json();
        if (smsData.success && smsData.smsTriggeredBetIds) {
          const smsMap: Record<string, boolean> = {};
          smsData.smsTriggeredBetIds.forEach((id: string) => {
            smsMap[id] = true;
          });
          setSmsTriggeredBets((prev) => ({ ...prev, ...smsMap }));
        }
      } catch (_) {}
    };
    if (bets.length > 0) fetchServerBetFlags();
  }, [bets]);

  useEffect(() => {
    return () => {
      if (darajaTestIntervalRef.current) {
        clearInterval(darajaTestIntervalRef.current);
      }
    };
  }, []);
  
  // Payment management state
  const [failedPayments, setFailedPayments] = useState<any[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [resolvingPayment, setResolvingPayment] = useState<string | null>(null);
  const [resolutionData, setResolutionData] = useState<Record<string, { mpesaReceipt?: string; resultDesc?: string }>>({});
  const [allTransactions, setAllTransactions] = useState<any[]>([]);
  const [allPayments, setAllPayments] = useState<any[]>([]);
  const [activationFees, setActivationFees] = useState<any[]>([]);
  
  // User balance editing state
  const [editingBalance, setEditingBalance] = useState<string | null>(null);
  const [balanceEditValue, setBalanceEditValue] = useState<string>("");
  const [balanceEditReason, setBalanceEditReason] = useState<string>("");
  const [darajaTestPhone, setDarajaTestPhone] = useState("");
  const [darajaTestAmount, setDarajaTestAmount] = useState("");
  const [isDarajaTesting, setIsDarajaTesting] = useState(false);
  const [darajaTestStatus, setDarajaTestStatus] = useState<string | null>(null);
  const [darajaTestMessage, setDarajaTestMessage] = useState("");
  const [darajaTestSession, setDarajaTestSession] = useState<null | {
    externalReference: string;
    checkoutRequestId: string;
    merchantRequestId?: string;
    phoneNumber: string;
    amount: number;
  }>(null);
  const darajaTestIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Image OCR import state
  const [showImageImport, setShowImageImport] = useState(false);
  const [importingImage, setImportingImage] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrRawText, setOcrRawText] = useState('');
  const [showRawText, setShowRawText] = useState(false);
  const [importResult, setImportResult] = useState<{ message: string; success: boolean } | null>(null);
  const [parsedImportGames, setParsedImportGames] = useState<Array<{
    id: string; league: string; homeTeam: string; awayTeam: string;
    homeOdds: string; drawOdds: string; awayOdds: string;
    kickoffDateTime: string; saving?: boolean; saved?: boolean;
  }>>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  
  // Admin withdrawal activation state
  const [activatingUserId, setActivatingUserId] = useState<string | null>(null);

  // Game details editing state
  const [editingGameDetails, setEditingGameDetails] = useState<string | null>(null);
  const [gameDetailsEdit, setGameDetailsEdit] = useState<Record<string, any>>({});
  // Custom time settings for timer
  const [customTimeSettings, setCustomTimeSettings] = useState<Record<string, number>>({});
  
  // Search and transaction state
  const [userSearchQuery, setUserSearchQuery] = useState<string>("");
  const [transactionSearchQuery, setTransactionSearchQuery] = useState<string>("");
  const [selectedUserTransactions, setSelectedUserTransactions] = useState<any>(null);

  // SMS broadcast state
  const [broadcastMessage, setBroadcastMessage] = useState<string>("");
  const [sendingBroadcast, setSendingBroadcast] = useState<boolean>(false);
  const [broadcastResult, setBroadcastResult] = useState<any>(null);
  const [broadcastFilters, setBroadcastFilters] = useState({
    searchTerm: "",
    activationStatus: "all",
    bettingStatus: "all",
    minBalance: "",
    minTotalWinnings: "",
    includeAdmins: false,
  });

  // Bet marking, moving, and deletion state
  const [markedBets, setMarkedBets] = useState<Set<string>>(new Set());
  const [movedBetIds, setMovedBetIds] = useState<Set<string>>(new Set());
  const [deletingMarkedBets, setDeletingMarkedBets] = useState(false);

  // Game marking and deletion state
  const [markedGames, setMarkedGames] = useState<Set<string>>(new Set());
  const [deletingMarkedGames, setDeletingMarkedGames] = useState(false);
  const [gameDeleteDateFilter, setGameDeleteDateFilter] = useState<string>("");
  const [allGamesDeleteDateFilter, setAllGamesDeleteDateFilter] = useState<string>("");

  // Use refs to track latest games and updateGame function in the interval
  const gamesRef = useRef(games);
  const updateGameRef = useRef(updateGame);

  // Update refs whenever games or updateGame changes
  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  useEffect(() => {
    updateGameRef.current = updateGame;
  }, [updateGame]);

  // Timer polling is now handled by OddsContext - no need to duplicate here
  // The games state from OddsContext is already updated every second for live games

  // Fetch users from backend when component mounts
  useEffect(() => {
    console.log('📦 Fetching users from backend...');
    fetchUsersFromBackend(loggedInUser?.phone);
    
    // Also fetch transactions, payments, and bets
    console.log('📦 Fetching transactions and payments...');
    fetchAllTransactions();
    fetchAllPayments();
    
    console.log('📦 Fetching all bets...');
    fetchAllBets();
  }, [loggedInUser?.phone]);

  useEffect(() => {
    const refreshInterval = window.setInterval(() => {
      fetchAllBets();
    }, 10000);

    return () => window.clearInterval(refreshInterval);
  }, [fetchAllBets]);

  // Fetch transactions for a specific user
  const fetchUserTransactions = async (userId: string, user?: any) => {
    try {
      setUserTransactionsLoading(true);
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/transactions/user/${userId}`, {
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();
      if (data.success) {
        setSelectedUserTransactions(data);
        setSelectedTransactionUser(user || null);
        setShowUserTransactionsDialog(true);
      } else {
        alert(`Error fetching transactions: ${data.error || data.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error fetching transactions:', error);
      alert('Failed to fetch transactions.');
    } finally {
      setUserTransactionsLoading(false);
    }
  };

  const handleTransactionStatusChange = async (transactionId: string, status: string) => {
    try {
      setTransactionActionInProgress(transactionId);
      await updateTransactionStatus(transactionId, status as any, loggedInUser?.phone);
      setSelectedUserTransactions((prev: any) => {
        if (!prev || !Array.isArray(prev.transactions)) return prev;
        return {
          ...prev,
          transactions: prev.transactions.map((tx: any) =>
            tx.id === transactionId ? { ...tx, status } : tx
          )
        };
      });
      setAllTransactions((prev: any[]) => prev.map((tx: any) => tx.id === transactionId ? { ...tx, status } : tx));
    } catch (error) {
      console.error('Failed to update transaction status:', error);
      alert('Failed to update transaction status.');
    } finally {
      setTransactionActionInProgress(null);
    }
  };

  // Filter users based on search query (case-insensitive)
  const filteredUsers = users.filter((user) => {
    const query = userSearchQuery.toLowerCase().trim();
    if (!query) return true;
    
    return (
      user.name?.toLowerCase().includes(query) ||
      user.username?.toLowerCase().includes(query) ||
      user.phone?.toLowerCase().includes(query) ||
      user.email?.toLowerCase().includes(query) ||
      user.betnexaId?.toLowerCase().includes(query)
    );
  });

  const previewBroadcastRecipients = users.filter((user) => {
    if (!user.phone) return false;
    if (!broadcastFilters.includeAdmins && user.level === 'Admin') return false;

    if (broadcastFilters.activationStatus === 'activated' && !user.withdrawalActivated) return false;
    if (broadcastFilters.activationStatus === 'not_activated' && user.withdrawalActivated) return false;

    if (broadcastFilters.bettingStatus === 'with_bets' && Number(user.totalBets || 0) <= 0) return false;
    if (broadcastFilters.bettingStatus === 'no_bets' && Number(user.totalBets || 0) > 0) return false;

    const minBalance = parseFloat(broadcastFilters.minBalance);
    if (!isNaN(minBalance) && Number(user.accountBalance || 0) < minBalance) return false;

    const minWinnings = parseFloat(broadcastFilters.minTotalWinnings);
    if (!isNaN(minWinnings) && Number(user.totalWinnings || 0) < minWinnings) return false;

    const q = broadcastFilters.searchTerm.trim().toLowerCase();
    if (q) {
      const name = String(user.name || '').toLowerCase();
      const username = String(user.username || '').toLowerCase();
      const phone = String(user.phone || '').toLowerCase();
      if (!name.includes(q) && !username.includes(q) && !phone.includes(q)) return false;
    }

    return true;
  });

  const handleSendBroadcast = async () => {
    const trimmed = broadcastMessage.trim();
    if (!trimmed) {
      alert('Please enter a message to broadcast.');
      return;
    }

    if (!loggedInUser?.phone) {
      alert('Admin phone is missing. Please log in again.');
      return;
    }

    setSendingBroadcast(true);
    setBroadcastResult(null);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/sms-broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          message: trimmed,
          filters: {
            ...broadcastFilters,
            minBalance: broadcastFilters.minBalance === '' ? null : Number(broadcastFilters.minBalance),
            minTotalWinnings: broadcastFilters.minTotalWinnings === '' ? null : Number(broadcastFilters.minTotalWinnings),
          },
        }),
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || data.message || 'Failed to send broadcast');
      }

      setBroadcastResult(data);
      alert(`✅ Broadcast sent. Delivered: ${data.sent}, Failed: ${data.failed}`);
    } catch (error) {
      console.error('Broadcast SMS error:', error);
      alert(`Failed to send broadcast SMS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSendingBroadcast(false);
    }
  };

  const toggleBetMark = (betId: string) => {
    setMarkedBets(prev => {
      const newSet = new Set(prev);
      if (newSet.has(betId)) {
        newSet.delete(betId);
      } else {
        newSet.add(betId);
      }
      return newSet;
    });
  };

  const moveMarkedBets = () => {
    if (markedBets.size === 0) {
      alert('No bets selected to move.');
      return;
    }

    const selectedIds = Array.from(markedBets);
    setMovedBetIds(prev => {
      const next = new Set(prev);
      selectedIds.forEach(id => next.add(id));
      return next;
    });
    setMarkedBets(new Set());
    alert(`✅ Moved ${selectedIds.length} bet(s) to the moved bets list.`);
  };

  const undoMovedBet = (betId: string) => {
    setMovedBetIds(prev => {
      const next = new Set(prev);
      next.delete(betId);
      return next;
    });
    alert('✅ Bet restored to active list.');
  };

  const deleteMarkedBets = async () => {
    if (markedBets.size === 0) {
      alert('No bets selected for deletion.');
      return;
    }

    if (!window.confirm(`⚠️ Are you sure you want to delete ${markedBets.size} marked bet(s)? This action cannot be undone.`)) {
      return;
    }

    setDeletingMarkedBets(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const betIdsArray = Array.from(markedBets);
      
      const response = await fetch(`${apiUrl}/api/admin/bets/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          betIds: betIdsArray
        })
      });

      const data = await response.json();
      
      if (data.success) {
        // Remove deleted bets from local state
        const newBets = bets.filter(b => !markedBets.has(b.id));
        setBets(newBets);
        setMarkedBets(new Set());
        alert(`✅ Successfully deleted ${data.deletedCount} bet(s)`);
      } else {
        alert(`Error: ${data.error || 'Failed to delete bets'}`);
      }
    } catch (error) {
      console.error('Error deleting marked bets:', error);
      alert(`Failed to delete bets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDeletingMarkedBets(false);
    }
  };

  const toggleGameMark = (gameId: string) => {
    setMarkedGames(prev => {
      const newSet = new Set(prev);
      if (newSet.has(gameId)) {
        newSet.delete(gameId);
      } else {
        newSet.add(gameId);
      }
      return newSet;
    });
  };

  const deleteMarkedGames = async () => {
    if (markedGames.size === 0) {
      alert('No games selected for deletion.');
      return;
    }

    const selectedGameList = Array.from(markedGames)
      .map((gameId) => games.find((g) => g.id === gameId))
      .filter(Boolean);
    const includesManualAdminGames = selectedGameList.some((game) => {
      const gameId = String(game?.game_id || game?.id || '');
      return !gameId.startsWith('af-') && !gameId.startsWith('ab-');
    });

    if (includesManualAdminGames) {
      const confirmed = window.confirm(
        `⚠️ You have selected ${selectedGameList.filter((game) => !String(game?.game_id || game?.id || '').startsWith('af-') && !String(game?.game_id || game?.id || '').startsWith('ab-')).length} admin-added match(es). This will permanently remove them from the system. Continue?`
      );
      if (!confirmed) return;
    }

    if (!window.confirm(`⚠️ Are you sure you want to delete ${markedGames.size} marked game(s)? This action cannot be undone.`)) {
      return;
    }

    setDeletingMarkedGames(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const gameIdsArray = Array.from(markedGames);
      
      const response = await fetch(`${apiUrl}/api/admin/games/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          gameIds: gameIdsArray
        })
      });

      const data = await response.json();
      
      if (data.success) {
        // Remove deleted games from local state
        const newGames = games.filter(g => !markedGames.has(g.id));
        refreshGames();
        setMarkedGames(new Set());
        alert(`✅ Successfully deleted ${data.deletedCount} game(s)`);
      } else {
        alert(`Error: ${data.error || 'Failed to delete games'}`);
      }
    } catch (error) {
      console.error('Error deleting marked games:', error);
      alert(`Failed to delete games: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDeletingMarkedGames(false);
    }
  };

  const handleAdminActivateWithdrawal = async (userId: string, userName: string) => {
    setActivatingUserId(userId);
    
    try {
      console.log(`🔓 Admin activating withdrawal for user: ${userId} (${userName})`);
      
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/users/${userId}/activate-withdrawal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone
        })
      });

      const data = await response.json();

      if (data.success) {
        console.log(`✅ Withdrawal activated successfully for ${userName}`);
        
        // Update local state immediately
        updateUser(userId, {
          withdrawalActivated: true,
          withdrawalActivationDate: new Date().toISOString()
        });
        
        // Show success message - NO FEE DEDUCTION ANYMORE
        alert(`✅ Withdrawal activated for ${userName}`);
        
        // Refresh user list to reflect changes
        await fetchUsersFromBackend(loggedInUser?.phone);
      } else {
        console.error(`❌ Activation failed:`, data.error);
        alert(`Error: ${data.error || 'Failed to activate withdrawal'}`);
      }
    } catch (error) {
      console.error('❌ Error activating withdrawal:', error);
      alert(`Failed to activate withdrawal: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setActivatingUserId(null);
    }
  };

  const handleAdminDeactivateWithdrawal = async (userId: string, userName: string) => {
    setActivatingUserId(userId);
    
    try {
      console.log(`🔒 Admin deactivating withdrawal for user: ${userId} (${userName})`);
      
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/users/${userId}/deactivate-withdrawal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone
        })
      });

      const data = await response.json();

      if (data.success) {
        console.log(`✅ Withdrawal deactivated successfully for ${userName}`);
        
        // Update local state immediately
        updateUser(userId, {
          withdrawalActivated: false,
          withdrawalActivationDate: null
        });
        
        // Show success message
        alert(`✅ Withdrawal deactivated for ${userName}`);
        
        // Refresh user list to reflect changes
        await fetchUsersFromBackend(loggedInUser?.phone);
      } else {
        console.error(`❌ Deactivation failed:`, data.error);
        alert(`Error: ${data.error || 'Failed to deactivate withdrawal'}`);
      }
    } catch (error) {
      console.error('❌ Error deactivating withdrawal:', error);
      alert(`Failed to deactivate withdrawal: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setActivatingUserId(null);
    }
  };

  const handleDeleteUser = async (userId: string, userName: string) => {
    try {
      console.log('🗑️ Deleting user:', userId, userName);
      
      // Log the user out if it's the current user being deleted
      if (userId === loggedInUser.id) {
        alert('⚠️ You cannot delete your own admin account');
        return;
      }

      // Call backend to delete user
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/payments/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();

      if (data.success) {
        console.log('✅ User deleted successfully:', userId);
        alert(`✅ User account for ${userName} has been permanently deleted.`);
        
        // Refresh user list
        const updatedUsers = users.filter((u) => u.id !== userId);
        // Note: The context will be updated automatically through the provider
      } else {
        console.error('❌ Delete failed:', data.message);
        alert(`❌ Failed to delete user: ${data.message}`);
      }
    } catch (error) {
      console.error('❌ Delete error:', error);
      alert(`❌ Error deleting user: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const addGameHandler = async () => {
    if (!newGame.homeTeam || !newGame.awayTeam) return;
    
    // Convert kickoffDateTime to ISO string
    let kickoffTime = new Date().toISOString();
    if (newGame.kickoffDateTime) {
      kickoffTime = new Date(newGame.kickoffDateTime).toISOString();
    }
    
    const h = parseFloat(newGame.homeOdds) || 2.0;
    const d = parseFloat(newGame.drawOdds) || 3.0;
    const a = parseFloat(newGame.awayOdds) || 3.0;

    // Build markets object from form input (no auto-generation)
    const markets: Record<string, number> = {};
    
    // Add 1X2 odds (always included)
    if (h) markets.home = h;
    if (d) markets.draw = d;
    if (a) markets.away = a;
    
    // Add all user-entered market odds (only if they entered a value)
    for (const [key, value] of Object.entries(newGame.markets)) {
      const numValue = parseFloat(value as string);
      if (numValue && numValue > 0) {
        markets[key] = numValue;
      }
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          league: newGame.league,
          homeTeam: newGame.homeTeam,
          awayTeam: newGame.awayTeam,
          homeOdds: h,
          drawOdds: d,
          awayOdds: a,
          time: kickoffTime,
          status: newGame.status,
          markets
        })
      });

      const data = await response.json();

      if (data.success) {
        // Add game to local context for immediate UI update
        const gameData: GameOdds = {
          id: data.game.game_id || data.game.id,
          league: data.game.league || '',
          homeTeam: data.game.home_team,
          awayTeam: data.game.away_team,
          homeOdds: parseFloat(data.game.home_odds),
          drawOdds: parseFloat(data.game.draw_odds),
          awayOdds: parseFloat(data.game.away_odds),
          time: data.game.time || kickoffTime,
          status: data.game.status || 'upcoming',
          markets: data.game.markets || {},
        };
        addGame(gameData);
        setNewGame({
          league: "",
          homeTeam: "",
          awayTeam: "",
          homeOdds: "",
          drawOdds: "",
          awayOdds: "",
          time: "",
          kickoffDateTime: "",
          status: "upcoming",
          markets: {
            bttsYes: "",
            bttsNo: "",
            over25: "",
            under25: "",
            over15: "",
            under15: "",
            doubleChanceHomeOrDraw: "",
            doubleChanceAwayOrDraw: "",
            doubleChanceHomeOrAway: "",
            htftHomeHome: "",
            htftDrawDraw: "",
            htftAwayAway: "",
            htftDrawHome: "",
            htftDrawAway: "",
            cs10: "",
            cs20: "",
            cs11: "",
            cs00: "",
            cs01: "",
            cs21: "",
            cs12: "",
            cs02: "",
            cs22: "",
            cs30: "",
            cs03: "",
            cs31: "",
            cs13: "",
            cs32: "",
            cs23: "",
            cs40: "",
            cs04: "",
            cs33: "",
            cs41: "",
            cs14: "",
            cs42: "",
            cs24: "",
            cs43: "",
            cs34: "",
            cs44: ""
          }
        });
        setShowAddGame(false);
        alert("✅ Game added with your custom market odds!");
        
        // Refresh games to sync with all users
        setTimeout(() => {
          refreshGames();
        }, 500);
      } else {
        console.error('API Error:', data);
        alert(`Error: ${data.error || 'Failed to add game'}`);
      }
    } catch (error) {
      console.error('Error adding game:', error);
      alert('Failed to add game. Check console for details.');
    }
  };

  // Parse OCR text — sequential collection + zip (handles column-layout OCR reading)
  const parseGamesFromText = useCallback((text: string) => {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results: typeof parsedImportGames = [];

    // Date regex: supports / - . separators (OCR may produce "13.03" instead of "13/03")
    const dateRx = /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.]?\d{2,4})?,?\s*(\d{1,2}:\d{2})/;
    const leagueKw = ['liga','league','serie','bundesliga','ligue','championship','cup','premier','champions','eredivisie','primeira','superliga'];
    const countriesKw = ['spain','italy','germany','france','england','portugal','netherlands','belgium','scotland','turkey','brazil','argentina','mexico','sweden','norway','denmark','austria','switzerland','kenya','usa','nigeria','south africa'];

    const isNoise = (l: string) => /markets?/i.test(l) || /^teams?\b/i.test(l) || /^[12X\s]+$/i.test(l) || /^\W+$/.test(l) || l.length < 2;
    const isLeagueLn = (l: string) => {
      const low = l.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
      return leagueKw.some(k => low.includes(k)) || countriesKw.some(c => low.includes(c));
    };
    const validOdds = (v: number) => v >= 1.01 && v <= 50;
    const buildKickoff = (day: number, month: number, time: string) => {
      const yr = new Date().getFullYear();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${yr}-${pad(month)}-${pad(day)}T${time}`;
    };

    console.log('[OCR Parser] Total lines:', lines.length);
    lines.forEach((l, i) => console.log(`  [${i}] "${l}"`));

    // ─── Collect ALL items into separate ordered lists ───
    const allOddsValues: number[] = [];
    const allTeams: string[] = [];
    const allLeagues: string[] = [];
    const allKickoffs: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isNoise(line)) continue;

      const isLeague = isLeagueLn(line);
      const dateMatch = line.match(dateRx);

      // Extract date/time if present
      if (dateMatch) {
        allKickoffs.push(buildKickoff(parseInt(dateMatch[1]), parseInt(dateMatch[2]), dateMatch[3]));
      }

      // League line → extract name, SKIP for team/odds processing
      if (isLeague) {
        const leagueName = line
          .replace(dateRx, '')
          .replace(/[^a-zA-Z0-9\s.•·\-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (leagueName.length >= 2) allLeagues.push(leagueName);
        continue;
      }

      // Date-only line (no meaningful text besides the date) → skip
      if (dateMatch) {
        const rest = line.replace(dateRx, '').replace(/[^a-zA-Z]/g, '').trim();
        if (rest.length < 2) continue;
      }

      // --- Extract decimal odds from this line ---
      const decRx = /\d+[.,]\d{1,2}/g;
      let dm;
      let foundDecimalOdds = false;
      while ((dm = decRx.exec(line)) !== null) {
        const v = parseFloat(dm[0].replace(',', '.'));
        if (validOdds(v)) {
          allOddsValues.push(v);
          foundDecimalOdds = true;
        }
      }

      // If no decimal odds, check for garbled 3-digit numbers (e.g. "234" → 2.34)
      if (!foundDecimalOdds) {
        const rx3 = /\b(\d{3})\b/g;
        let m3;
        while ((m3 = rx3.exec(line)) !== null) {
          const candidate = parseFloat(m3[1][0] + '.' + m3[1].slice(1));
          if (validOdds(candidate)) {
            allOddsValues.push(candidate);
          }
        }
      }

      // --- Extract team name: strip ALL numbers/symbols, keep only letters ---
      const teamText = line
        .replace(/\d+[.,]\d{1,2}/g, '')   // remove decimal numbers
        .replace(/\b\d{1,4}\b/g, '')       // remove bare numbers
        .replace(/[^a-zA-Z\s.'\-()]/g, '') // keep only text chars
        .replace(/\s+/g, ' ')
        .trim();

      if (teamText.length >= 2) {
        allTeams.push(teamText);
      }
    }

    console.log('[OCR Parser] Teams:', allTeams);
    console.log('[OCR Parser] Odds:', allOddsValues);
    console.log('[OCR Parser] Leagues:', allLeagues);
    console.log('[OCR Parser] Kickoffs:', allKickoffs);

    // ─── Group odds into triplets (every 3 consecutive = one game's 1X2) ───
    const triplets: { h: number; d: number; a: number }[] = [];
    for (let i = 0; i + 2 < allOddsValues.length; i += 3) {
      triplets.push({ h: allOddsValues[i], d: allOddsValues[i + 1], a: allOddsValues[i + 2] });
    }
    console.log('[OCR Parser] Triplets:', triplets.map(t => `${t.h}/${t.d}/${t.a}`));

    // ─── Zip: pair teams (every 2 = home+away) with odds triplets, leagues, kickoffs ───
    const numGames = Math.min(Math.floor(allTeams.length / 2), triplets.length);
    for (let i = 0; i < numGames; i++) {
      const homeTeam = allTeams[i * 2];
      const awayTeam = allTeams[i * 2 + 1];
      const trip = triplets[i];
      const league = allLeagues[i] || 'General';
      const kickoff = allKickoffs[i] || '';

      if (homeTeam.length < 2 || awayTeam.length < 2) continue;

      console.log(`[OCR Parser] ✅ Game ${i + 1}: ${homeTeam} vs ${awayTeam} | ${league} | ${kickoff} | ${trip.h}/${trip.d}/${trip.a}`);

      results.push({
        id: `imp_${Date.now()}_${i}`,
        league,
        homeTeam,
        awayTeam,
        homeOdds: trip.h.toFixed(2),
        drawOdds: trip.d.toFixed(2),
        awayOdds: trip.a.toFixed(2),
        kickoffDateTime: kickoff,
      });
    }

    console.log(`[OCR Parser] Total games found: ${results.length}`);
    return results;
  }, []);

  // Preprocess dark-background betting screenshots for better OCR
  const preprocessImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas not supported')); return; }

        // Draw original
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Convert to grayscale, invert, and boost contrast
        for (let i = 0; i < data.length; i += 4) {
          // Grayscale
          let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          // Invert (dark bg becomes white)
          gray = 255 - gray;
          // Boost contrast
          gray = gray < 100 ? 0 : gray > 160 ? 255 : ((gray - 100) / 60) * 255;
          data[i] = data[i + 1] = data[i + 2] = gray;
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  };

  // Global paste listener — works anywhere on the page when image import is open
  useEffect(() => {
    if (!showImageImport || importingImage) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) handleImageImport(file);
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [showImageImport, importingImage]);

  const handleImageImport = async (file: File) => {
    setImportingImage(true);
    setImportResult(null);
    setParsedImportGames([]);
    setOcrProgress(0);
    setOcrRawText('');
    setShowRawText(false);
    try {
      const Tesseract = await import('tesseract.js');

      // Preprocess: invert dark background for much better OCR accuracy
      setOcrProgress(5);
      const processedDataUrl = await preprocessImage(file);

      const { data: { text } } = await Tesseract.recognize(processedDataUrl, 'eng', {
        logger: (m: any) => {
          if (m.status === 'recognizing text') {
            setOcrProgress(10 + Math.round(m.progress * 85));
          }
        },
      });

      console.log('OCR text (preprocessed):', text);
      setOcrRawText(text);

      let games = parseGamesFromText(text);

      // If we got fewer than 4, try again with the original (unprocessed) image
      if (games.length < 4) {
        console.log(`[OCR] Only found ${games.length} games with preprocessed image, trying original...`);
        const origUrl = URL.createObjectURL(file);
        const { data: { text: origText } } = await Tesseract.recognize(origUrl, 'eng', {
          logger: (m: any) => {
            if (m.status === 'recognizing text') {
              setOcrProgress(95 + Math.round(m.progress * 5));
            }
          },
        });
        URL.revokeObjectURL(origUrl);
        console.log('OCR text (original):', origText);

        const origGames = parseGamesFromText(origText);
        // Merge: add any games from original that aren't already found
        for (const og of origGames) {
          if (!games.some(g => g.homeTeam === og.homeTeam && g.awayTeam === og.awayTeam)) {
            games.push({ ...og, id: `imp_${Date.now()}_merge_${games.length}` });
          }
        }
        // Update raw text to show both passes
        if (origGames.length > 0) {
          setOcrRawText(prev => prev + '\n\n--- Original image OCR ---\n' + origText);
        }
      }

      if (games.length > 0) {
        setParsedImportGames(games);
        const msg = games.length >= 4
          ? `Found all 4 games! Review and edit below, then click Execute to add.`
          : `Found ${games.length} of 4 games. You can add missing ones manually. Review below.`;
        setImportResult({ message: msg, success: true });
      } else {
        setImportResult({ message: 'No games detected. Try a clearer or higher-resolution screenshot.', success: false });
      }
    } catch (error: any) {
      console.error('OCR error:', error);
      setImportResult({ message: 'Failed to read image. Try again with a different image.', success: false });
    } finally {
      setImportingImage(false);
      setOcrProgress(0);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  // Save a single parsed game to DB
  const executeImportGame = async (gameIdx: number) => {
    const pg = parsedImportGames[gameIdx];
    if (!pg || pg.saving || pg.saved) return;
    setParsedImportGames(prev => prev.map((g, i) => i === gameIdx ? { ...g, saving: true } : g));
    try {
      const h = parseFloat(pg.homeOdds) || 2.0;
      const d = parseFloat(pg.drawOdds) || 3.0;
      const a = parseFloat(pg.awayOdds) || 3.0;
      const kickoffTime = pg.kickoffDateTime
        ? new Date(pg.kickoffDateTime + ':00+03:00').toISOString() // EAT = UTC+3
        : new Date().toISOString();
      const markets: Record<string, number> = { home: h, draw: d, away: a };
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loggedInUser.phone, league: pg.league, homeTeam: pg.homeTeam, awayTeam: pg.awayTeam, homeOdds: h, drawOdds: d, awayOdds: a, time: kickoffTime, status: 'upcoming', markets }),
      });
      const data = await response.json();
      if (data.success) {
        setParsedImportGames(prev => prev.map((g, i) => i === gameIdx ? { ...g, saving: false, saved: true } : g));
        refreshGames();
      } else {
        throw new Error(data.error || 'Failed');
      }
    } catch (err: any) {
      setParsedImportGames(prev => prev.map((g, i) => i === gameIdx ? { ...g, saving: false } : g));
      alert(`Failed to add ${pg.homeTeam} vs ${pg.awayTeam}: ${err.message}`);
    }
  };

  // Execute all unsaved parsed games
  const executeAllImportGames = async () => {
    for (let i = 0; i < parsedImportGames.length; i++) {
      if (!parsedImportGames[i].saved) {
        await executeImportGame(i);
      }
    }
  };

  const removeImportGame = (idx: number) => {
    setParsedImportGames(prev => prev.filter((_, i) => i !== idx));
  };

  const updateImportGame = (idx: number, field: string, value: string) => {
    setParsedImportGames(prev => prev.map((g, i) => i === idx ? { ...g, [field]: value } : g));
  };

  const addEmptyImportGame = () => {
    setParsedImportGames(prev => [...prev, {
      id: `imp_manual_${Date.now()}`,
      league: '', homeTeam: '', awayTeam: '',
      homeOdds: '', drawOdds: '', awayOdds: '',
      kickoffDateTime: '',
    }]);
  };

  const isApiManagedGame = (gameId: string) => gameId?.startsWith('af-');

  const ensureManualGame = (gameId: string) => {
    if (!isApiManagedGame(gameId)) return true;
    alert('API-Football matches are managed automatically. Admin can only edit manually added matches.');
    return false;
  };

  const regenerateOdds = async (id: string) => {
    if (!ensureManualGame(id)) return;
    const game = games.find((g) => g.id === id);
    if (!game) return;

    try {
      // Send existing DB markets to be re-saved (preserves all custom values)
      const existingMarkets = game.markets || {};
      
      // Filter to only include valid numeric odds
      const cleanMarkets: Record<string, number> = {};
      for (const [k, v] of Object.entries(existingMarkets)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 1.01) {
          cleanMarkets[k] = v;
        }
      }

      if (Object.keys(cleanMarkets).length === 0) {
        alert('⚠️ No markets to regenerate. Use Edit Details to add market odds.');
        return;
      }
      
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${id}/markets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          markets: cleanMarkets
        })
      });

      const data = await response.json();

      if (data.success) {
        updateGameMarkets(id, data.savedMarkets || cleanMarkets);
        alert('✅ Odds regenerated successfully!');
      } else {
        alert(`Error: ${data.error || 'Failed to regenerate odds'}`);
      }
    } catch (error) {
      console.error('Error regenerating odds:', error);
      alert('Failed to regenerate odds');
    }
  };

  const toggleHot = async (id: string) => {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    const newHot = !game.isHot;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${id}/hot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loggedInUser.phone, is_hot: newHot })
      });
      const data = await response.json();
      if (data.success) {
        updateGame(id, { isHot: newHot } as any);
        alert(newHot ? '🔥 Match marked as Hot!' : '❄️ Match unmarked as Hot');
      } else {
        alert(`Error: ${data.error || 'Failed to toggle hot status'}`);
      }
    } catch (error) {
      console.error('Error toggling hot:', error);
      alert('Failed to toggle hot status');
    }
  };

  const removeGameHandler = async (id: string) => {
    if (!confirm('Are you sure you want to delete this game?')) return;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loggedInUser.phone })
      });

      const data = await response.json();

      if (data.success) {
        removeGame(id);
        alert('✅ Game deleted successfully!');
      } else {
        alert(`Error: ${data.error || 'Failed to delete game'}`);
      }
    } catch (error) {
      console.error('Error deleting game:', error);
      alert('Failed to delete game');
    }
  };

  // Live play functions
  const startKickoff = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const now = new Date().toISOString();
      
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          status: "live",
          minute: 0,
          seconds: 0,
          homeScore: 0,
          awayScore: 0,
          isKickoffStarted: true,
          gamePaused: false,
          kickoffStartTime: now
        })
      });

      const data = await response.json();

      if (data.success) {
        // Use the current time we just sent, NOT the backend's response
        // This ensures the timer starts at 0:00 correctly
        console.log(`🎯 Kickoff started at: ${now}`);
        
        // Start timer immediately at 0:00 and begin counting
        updateGame(gameId, {
          status: "live",
          minute: 0,
          seconds: 0,
          homeScore: 0,
          awayScore: 0,
          isKickoffStarted: true,
          gamePaused: false,
          kickoffStartTime: now
        });
        alert('✅ Kickoff started! Timer counting 0:00');
      } else {
        alert(`Error: ${data.details || data.error || 'Failed to start kickoff'}`);
      }
    } catch (error) {
      console.error('Error starting kickoff:', error);
      alert('Failed to start kickoff: ' + error.message);
    }
  };

  const pauseKickoff = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game || game.minute === undefined) return;

    try {
      const now = new Date().toISOString();
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          gamePaused: true,
          kickoffPausedAt: now
        })
      });

      const data = await response.json();

      if (data.success) {
        const kickoffPausedAt = data.game?.kickoff_paused_at || now;
        updateGame(gameId, {
          gamePaused: true,
          kickoffPausedAt: kickoffPausedAt
        });
        alert('⏸️ Game paused!');
      } else {
        console.error('Pause error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to pause game'}`);
      }
    } catch (error) {
      console.error('Error pausing game:', error);
      alert('Failed to pause game: ' + error.message);
    }
  };

  const resumeKickoff = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game || !game.kickoffStartTime || !game.kickoffPausedAt) return;

    try {
      // Convert ISO strings to milliseconds for calculation
      const kickoffStartMs = typeof game.kickoffStartTime === 'string' 
        ? new Date(game.kickoffStartTime).getTime() 
        : game.kickoffStartTime;
      const pausedAtMs = typeof game.kickoffPausedAt === 'string' 
        ? new Date(game.kickoffPausedAt).getTime() 
        : game.kickoffPausedAt;
      
      // Calculate pause duration and adjust kickoff start time
      const pauseDuration = Date.now() - pausedAtMs;
      const newKickoffStartTimeMs = kickoffStartMs + pauseDuration;
      const newKickoffStartTime = new Date(newKickoffStartTimeMs).toISOString();

      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          gamePaused: false,
          isKickoffStarted: true,
          kickoffStartTime: newKickoffStartTime,
          kickoffPausedAt: null
        })
      });

      const data = await response.json();

      if (data.success) {
        const kickoffStartTime = data.game?.kickoff_start_time || newKickoffStartTime;
        updateGame(gameId, {
          gamePaused: false,
          isKickoffStarted: true,
          kickoffStartTime: kickoffStartTime,
          kickoffPausedAt: undefined
        });
        alert('▶️ Game resumed!');
      } else {
        console.error('Resume error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to resume game'}`);
      }
    } catch (error) {
      console.error('Error resuming game:', error);
      alert('Failed to resume game: ' + error.message);
    }
  };

  const adjustOddsBasedOnScore = (baseHomeOdds: number, baseDrawOdds: number, baseAwayOdds: number, homeScore: number, awayScore: number) => {
    const scoreDiff = homeScore - awayScore;
    const totalGoals = homeScore + awayScore;
    
    let newHomeOdds = baseHomeOdds;
    let newDrawOdds = baseDrawOdds;
    let newAwayOdds = baseAwayOdds;
    
    if (scoreDiff > 0) {
      // Home is leading - decrease home odds, increase away odds
      const adjustment = Math.min(scoreDiff * 0.15, 0.8);
      newHomeOdds = Math.max(baseHomeOdds - adjustment, 1.1);
      newAwayOdds = baseAwayOdds + (adjustment * 1.5);
      newDrawOdds = baseDrawOdds + (adjustment * 0.8);
    } else if (scoreDiff < 0) {
      // Away is leading - decrease away odds, increase home odds
      const adjustment = Math.min(Math.abs(scoreDiff) * 0.15, 0.8);
      newAwayOdds = Math.max(baseAwayOdds - adjustment, 1.1);
      newHomeOdds = baseHomeOdds + (adjustment * 1.5);
      newDrawOdds = baseDrawOdds + (adjustment * 0.8);
    } else {
      // It's a draw - balance the odds
      const avgOdds = (baseHomeOdds + baseAwayOdds) / 2;
      newHomeOdds = avgOdds;
      newAwayOdds = avgOdds;
      newDrawOdds = Math.max(baseDrawOdds - 0.2, 2.0);
    }
    
    return {
      homeOdds: parseFloat(newHomeOdds.toFixed(2)),
      drawOdds: parseFloat(newDrawOdds.toFixed(2)),
      awayOdds: parseFloat(newAwayOdds.toFixed(2)),
    };
  };

  const updateLiveScore = async (gameId: string, homeScore: number, awayScore: number) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const newOdds = adjustOddsBasedOnScore(game.homeOdds, game.drawOdds, game.awayOdds, homeScore, awayScore);
      // Preserve existing DB markets, only update 1X2 odds
      const existingMarkets = game.markets || {};

      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/score`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          homeScore,
          awayScore,
          minute: game.minute,
          status: game.status
        })
      });

      const data = await response.json();

      if (data.success) {
        // Update local state - preserve DB markets, update 1X2 odds
        updateGame(gameId, {
          homeScore,
          awayScore,
          homeOdds: newOdds.homeOdds,
          drawOdds: newOdds.drawOdds,
          awayOdds: newOdds.awayOdds,
          markets: existingMarkets,
        });
      } else {
        alert(`Error: ${data.error || 'Failed to update score'}`);
      }
    } catch (error) {
      console.error('Error updating score:', error);
      alert('Failed to update score');
    }
  };

  const endGame = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/end`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
        })
      });

      const data = await response.json();

      if (data.success) {
        updateGame(gameId, {
          status: "finished",
        });
        alert('✅ Game finished!');
      } else {
        console.error('End game error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to end game'}`);
      }
    } catch (error) {
      console.error('Error ending game:', error);
      alert('Failed to end game: ' + error.message);
    }
  };

  const revertGame = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    if (!window.confirm('⚠️ Are you sure you want to revert this finished game back to LIVE?\n\nThis will unsettl all settled bets and reverse any winnings credited.')) {
      return;
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/revert`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
        })
      });

      const data = await response.json();

      if (data.success) {
        updateGame(gameId, {
          status: "live",
        });
        alert('✅ Game reverted to LIVE! All settled bets have been unsettled.');
      } else {
        console.error('Revert game error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to revert game'}`);
      }
    } catch (error) {
      console.error('Error reverting game:', error);
      alert('Failed to revert game: ' + error.message);
    }
  };

  const markHalftime = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      console.log(`⏱️  Marking halftime for game: ${gameId}`);
      
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/halftime`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
        })
      });

      const data = await response.json();
      console.log('📊 Halftime response:', data);

      if (data.success) {
        updateGame(gameId, { isHalftime: true, gamePaused: true });
        alert('✅ Halftime marked! Timer paused at 45:00');
      } else {
        console.error('❌ Halftime error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to mark halftime'}`);
      }
    } catch (error) {
      console.error('Error marking halftime:', error);
      alert('Failed to mark halftime: ' + error.message);
    }
  };

  const resumeSecondHalf = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      console.log(`▶️  Resuming second half for game: ${gameId}`);
      
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/resume-second-half`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
        })
      });

      const data = await response.json();
      console.log('📊 Resume second half response:', data);

      if (data.success) {
        // Calculate the adjusted kickoff time for 45:00 start
        const now = new Date();
        const secondsIntoSecondHalf = 45 * 60; // 45 minutes
        const newKickoffTime = new Date(now.getTime() - secondsIntoSecondHalf * 1000);

        updateGame(gameId, { 
          isHalftime: false, 
          gamePaused: false,
          kickoffStartTime: newKickoffTime.toISOString(),
          minute: 45,
          seconds: 0
        });
        alert('✅ Second half resumed! Timer starting at 45:00');
      } else {
        console.error('❌ Resume second half error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to resume second half'}`);
      }
    } catch (error) {
      console.error('Error resuming second half:', error);
      alert('Failed to resume second half: ' + error.message);
    }
  };

  const markGameLive = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      console.log(`🔴 Marking game as live: ${gameId}`);
      
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          status: "live"
        })
      });

      const data = await response.json();
      console.log('📊 Mark live response:', data);

      if (data.success) {
        updateGame(gameId, { status: "live" });
        alert('✅ Game marked as live!');
      } else {
        console.error('❌ Mark live error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to mark game as live'}`);
      }
    } catch (error) {
      console.error('Error marking game live:', error);
      alert('Failed to mark game as live: ' + error.message);
    }
  };

  const updateGameDetails = async (gameId: string) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    const details = gameDetailsEdit[gameId];
    if (!details) return;

    let marketsSaved = false;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      console.log(`✏️  Updating game details: ${gameId}`);
      
      // Update game details (league, teams, kickoff, 1X2 odds)
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/details`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          phone: loggedInUser.phone,
          league: details.league || game.league,
          homeTeam: details.homeTeam || game.homeTeam,
          awayTeam: details.awayTeam || game.awayTeam,
          homeOdds: details.homeOdds ? parseFloat(details.homeOdds) : game.homeOdds,
          drawOdds: details.drawOdds ? parseFloat(details.drawOdds) : game.drawOdds,
          awayOdds: details.awayOdds ? parseFloat(details.awayOdds) : game.awayOdds,
          kickoffTime: details.kickoffTime || game.time
        })
      });

      const data = await response.json();
      console.log('📊 Update details response:', data);

      if (!data.success) {
        console.error('❌ Update error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to update game details'}`);
        return;
      }

      // If markets are provided, also save them
      if (details.markets && Object.keys(details.markets).length > 0) {
        console.log(`📊 Saving markets for game ${gameId}`);
        const marketsToSave = Object.fromEntries(
          Object.entries(details.markets).filter(([_, v]) => {
            if (v == null || v === undefined) return false;
            const num = typeof v === 'number' ? v : parseFloat(v as any);
            return Number.isFinite(num) && num > 0;
          })
        );
        
        if (Object.keys(marketsToSave).length > 0) {
          const marketPayload = Object.fromEntries(
            Object.entries(marketsToSave).map(([k, v]) => [k, typeof v === 'number' ? v : parseFloat(v as any)])
          );
          console.log(`📊 Sending ${Object.keys(marketPayload).length} markets to backend:`, JSON.stringify(marketPayload).slice(0, 200));
          
          const marketsResponse = await fetch(`${apiUrl}/api/admin/games/${gameId}/markets`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              phone: loggedInUser.phone,
              markets: marketPayload
            })
          });

          const marketsData = await marketsResponse.json();
          console.log('📊 Markets save response:', marketsData);
          
          if (!marketsData.success) {
            console.error('❌ Markets save error:', marketsData);
            alert(`⚠️ Game details saved but markets failed: ${marketsData.error || 'Unknown error'}`);
            return;
          }
          
          // Use the verified saved markets from the backend response
          if (marketsData.savedMarkets) {
            marketsSaved = true;
            updateGame(gameId, {
              league: details.league || game.league,
              homeTeam: details.homeTeam || game.homeTeam,
              awayTeam: details.awayTeam || game.awayTeam,
              homeOdds: details.homeOdds ? parseFloat(details.homeOdds) : game.homeOdds,
              drawOdds: details.drawOdds ? parseFloat(details.drawOdds) : game.drawOdds,
              awayOdds: details.awayOdds ? parseFloat(details.awayOdds) : game.awayOdds,
              time: details.kickoffTime || game.time,
              markets: marketsData.savedMarkets
            });
          }
        }
      }

      // Update UI (only if markets weren't already handled above)
      if (!marketsSaved) {
        updateGame(gameId, {
          league: details.league || game.league,
          homeTeam: details.homeTeam || game.homeTeam,
          awayTeam: details.awayTeam || game.awayTeam,
          homeOdds: details.homeOdds ? parseFloat(details.homeOdds) : game.homeOdds,
          drawOdds: details.drawOdds ? parseFloat(details.drawOdds) : game.drawOdds,
          awayOdds: details.awayOdds ? parseFloat(details.awayOdds) : game.awayOdds,
          time: details.kickoffTime || game.time,
        });
      }

      // Force refresh from database to ensure all clients see updated markets
      await refreshGames();

      setEditingGameDetails(null);
      const newEdit = { ...gameDetailsEdit };
      delete newEdit[gameId];
      setGameDetailsEdit(newEdit);
      alert('✅ Game details and markets updated!');
    } catch (error) {
      console.error('Error updating game details:', error);
      alert('Failed to update game details: ' + error.message);
    }
  };

  const setCustomGameTime = async (gameId: string, minute: number, seconds: number) => {
    if (!ensureManualGame(gameId)) return;
    const game = games.find((g) => g.id === gameId);
    if (!game) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      console.log(`⏱️  Setting custom time for game: ${gameId} to ${minute}:${seconds}`);
      
      const response = await fetch(`${apiUrl}/api/admin/games/${gameId}/set-time`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser.phone,
          minute,
          seconds
        })
      });

      const data = await response.json();
      console.log('📊 Set time response:', data);

      if (data.success) {
        updateGame(gameId, {
          minute,
          seconds,
          kickoffStartTime: data.newKickoffStartTime
        });
        alert(`✅ Timer set to ${minute}:${String(seconds).padStart(2, '0')}`);
      } else {
        console.error('❌ Set time error:', data);
        alert(`Error: ${data.details || data.error || 'Failed to set timer'}`);
      }
    } catch (error) {
      console.error('Error setting custom time:', error);
      alert('Failed to set timer: ' + error.message);
    }
  };

  const settleBetBySelections = async (betId: string) => {
    const outcomes = selectionOutcomes[betId];
    if (!outcomes || Object.keys(outcomes).length === 0) return;

    const won = Object.values(outcomes).filter(o => o === "won").length;
    const lost = Object.values(outcomes).filter(o => o === "lost").length;
    const total = Object.keys(outcomes).length;

    // For a multibet, all selections must be won for the bet to win
    if (won === total && lost === 0) {
      const bet = bets.find(b => b.id === betId);
      if (bet) {
        const result = await updateBetStatus(betId, "Won", bet.potentialWin);
        if (result.success) {
          console.log(`✅ Bet ${betId} marked as Won with KSH ${bet.potentialWin}`);
          // Refresh user data to show updated balance
          console.log('🔄 Refreshing user data to show updated balance');
          await fetchUsersFromBackend();
        } else {
          console.error(`❌ Failed to mark bet as Won:`, result.error);
          alert(`Failed to settle bet: ${result.error}`);
          return;
        }
      }
    } else {
      // If any selection is lost, the bet is lost
      const result = await updateBetStatus(betId, "Lost", 0);
      if (result.success) {
        console.log(`✅ Bet ${betId} marked as Lost`);
        // Refresh user data after settling
        console.log('🔄 Refreshing user data after bet settlement');
        await fetchUsersFromBackend();
      } else {
        console.error(`❌ Failed to mark bet as Lost:`, result.error);
        alert(`Failed to settle bet: ${result.error}`);
        return;
      }
    }

    // Clear the outcomes after settling
    const newOutcomes = { ...selectionOutcomes };
    delete newOutcomes[betId];
    setSelectionOutcomes(newOutcomes);
  };

  const sendBetDetailsSms = async (bet: any) => {
    if (!bet?.id || sendingBetSmsId === bet.id || smsTriggeredBets[bet.id]) return;
    setSendingBetSmsId(bet.id);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const adminPhone = localStorage.getItem("adminPhone") || localStorage.getItem("userPhone") || loggedInUser?.phone || "0712345678";
      const response = await fetch(`${apiUrl}/api/admin/bets/${bet.id}/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: adminPhone }),
      });

      const data = await response.json();
      if (!data.success) {
        alert(`SMS failed: ${data.error || 'Failed to send bet SMS'}`);
        return;
      }

      setSmsTriggeredBets((prev) => ({ ...prev, [bet.id]: true }));
      setBets((prev) => prev.map((existingBet) => (
        existingBet.id === bet.id
          ? {
              ...existingBet,
              status: (data.betStatus || 'Won') as typeof existingBet.status,
            }
          : existingBet
      )));
      await fetchAllBets();
      await fetchUsersFromBackend();

      const phoneMsg = data.phoneNumber || bet.phone_number || 'user';
      const smsMsg = data.smsSent ? `SMS sent to ${phoneMsg}` : `Balance updated, but SMS not sent (invalid or missing phone)`;
      alert(`${smsMsg} for bet #${bet.betId}`);
    } catch (error: any) {
      alert(`Failed to send SMS: ${error?.message || 'Unknown error'}`);
    } finally {
      setSendingBetSmsId(null);
    }
  };

  // Fetch failed payments
  const fetchFailedPayments = async () => {
    setLoadingPayments(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/payments/admin/failed`);
      const data = await response.json();
      if (data.success) {
        setFailedPayments(data.payments || []);
      }
    } catch (error) {
      console.error("Failed to fetch failed payments:", error);
    } finally {
      setLoadingPayments(false);
    }
  };

  // Fetch all transactions
  const fetchAllTransactions = async () => {
    setLoadingPayments(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const phone = loggedInUser?.phone || '';
      const response = await fetch(`${apiUrl}/api/admin/transactions?phone=${encodeURIComponent(phone)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (data.success) {
        setAllTransactions(data.transactions || []);
        setActivationFees(data.activation_fees || []);
      }
    } catch (error) {
      console.error("Failed to fetch transactions:", error);
    } finally {
      setLoadingPayments(false);
    }
  };

  const normalizePhoneNumber = (value?: string) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
    if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return `254${digits}`;
    return digits || '';
  };

  const resolveUsernameFromCache = (userId?: string, phoneNumber?: string) => {
    if (!Array.isArray(users) || users.length === 0) return '';

    if (userId) {
      const byId = users.find((u: any) => u.id === userId);
      if (byId?.username) return byId.username;
      if (byId?.name) return byId.name;
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (normalizedPhone) {
      const byPhone = users.find((u: any) => normalizePhoneNumber(u.phone) === normalizedPhone);
      if (byPhone?.username) return byPhone.username;
      if (byPhone?.name) return byPhone.name;
    }

    return '';
  };

  const getTransactionAccountLabel = (transaction: any) => {
    return (
      transaction.username ||
      resolveUsernameFromCache(transaction.user_id, transaction.phone_number) ||
      transaction.phone_number ||
      transaction.user_id?.substring(0, 8) ||
      'User'
    );
  };

  const transactionQuery = transactionSearchQuery.trim().toLowerCase();

  const filteredTransactions = allTransactions.filter((transaction: any) => {
    if (!transactionQuery) return true;

    const accountLabel = String(getTransactionAccountLabel(transaction) || '').toLowerCase();
    const phone = String(transaction.phone_number || '').toLowerCase();
    return accountLabel.includes(transactionQuery) || phone.includes(transactionQuery);
  });

  const filteredActivationFees = activationFees.filter((fee: any) => {
    if (!transactionQuery) return true;

    const accountLabel = String(
      resolveUsernameFromCache(fee.user_id, fee.phone_number) ||
      fee.phone_number ||
      fee.user_id?.substring(0, 8) ||
      'User'
    ).toLowerCase();
    const phone = String(fee.phone_number || '').toLowerCase();
    return accountLabel.includes(transactionQuery) || phone.includes(transactionQuery);
  });

  // Fetch all payments
  const fetchAllPayments = async () => {
    setLoadingPayments(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const phone = loggedInUser?.phone || '';
      const response = await fetch(`${apiUrl}/api/admin/payments?phone=${encodeURIComponent(phone)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (data.success) {
        setAllPayments(data.payments || []);
      }
    } catch (error) {
      console.error("Failed to fetch payments:", error);
    } finally {
      setLoadingPayments(false);
    }
  };

  // Resolve a failed payment
  const resolveFailedPayment = async (externalReference: string) => {
    try {
      setResolvingPayment(externalReference);
      const data = resolutionData[externalReference] || {};

      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(
        `${apiUrl}/api/payments/admin/resolve/${externalReference}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mpesaReceipt: data.mpesaReceipt || `ADMIN-RESOLVED-${Date.now()}`,
            resultDesc: data.resultDesc || "Admin resolved - Failed payment marked as success"
          })
        }
      );

      const result = await response.json();
      if (result.success) {
        // Remove from failed payments list
        setFailedPayments(prev => prev.filter(p => p.external_reference !== externalReference));
        // Clear resolution data
        const newData = { ...resolutionData };
        delete newData[externalReference];
        setResolutionData(newData);
        alert("Payment resolved successfully!");
      } else {
        alert("Failed to resolve payment: " + (result.message || "Unknown error"));
      }
    } catch (error) {
      console.error("Error resolving payment:", error);
      alert("Error resolving payment");
    } finally {
      setResolvingPayment(null);
    }
  };

  // Calculate real-time stats
  const totalUsers = getAllUsers().length;
  const todaySignups = getAllUsers().filter((u) => {
    if (!u.createdAt) return false;
    const createdDate = new Date(u.createdAt);
    if (Number.isNaN(createdDate.getTime())) return false;
    return createdDate.toDateString() === new Date().toDateString();
  }).length;
  
  const activeBets = bets.filter(b => b.status === "Open").length;
  
  const todayRevenue = allTransactions
    .filter((t: any) => {
      // Check if transaction is from today
      const today = new Date();
      const transDate = new Date(t.created_at || t.date || new Date());
      return t.type === "deposit" && 
             t.status === "completed" &&
             transDate.toDateString() === today.toDateString();
    })
    .reduce((sum: number, t: any) => sum + Number(t.amount), 0);

  const stats: Array<{ icon: any; label: string; value: string; color: string; note?: string }> = [
    { icon: Users, label: "Total Users", value: totalUsers.toLocaleString(), color: "text-primary" },
    { icon: UserPlus, label: "Signed Up Today", value: todaySignups.toLocaleString(), color: "text-primary" },
    { icon: BarChart3, label: "Active Bets", value: activeBets.toLocaleString(), color: "text-primary" },
    { icon: Trophy, label: "Games Today", value: games.length.toString(), color: "text-gold" },
  ];

  const stopDarajaTestPolling = () => {
    if (darajaTestIntervalRef.current) {
      clearInterval(darajaTestIntervalRef.current);
      darajaTestIntervalRef.current = null;
    }
  };

  const pollDarajaTestStatus = (checkoutRequestId: string) => {
    stopDarajaTestPolling();

    let attempts = 0;
    const maxAttempts = 60;

    const runStatusCheck = async () => {
      attempts += 1;

      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
        const response = await fetch(`${apiUrl}/api/admin/daraja-test/status?phone=${encodeURIComponent(loggedInUser?.phone || '')}&checkoutRequestId=${encodeURIComponent(checkoutRequestId)}`);
        const data = await response.json();

        if (!response.ok || !data.success) {
          if (attempts >= maxAttempts) {
            setDarajaTestStatus('failed');
            setDarajaTestMessage(data.error || 'Failed to fetch Daraja test status');
            stopDarajaTestPolling();
          }
          return;
        }

        setDarajaTestStatus(data.status || 'pending');

        if (data.status === 'success') {
          if (loggedInUser?.id) {
            const syncedBalance = await balanceSyncService.sync(loggedInUser.id);
            if (syncedBalance !== null) {
              updateCurrentUser({ accountBalance: syncedBalance });
            }
          }
          await fetchUsersFromBackend();
          const receipt = data.result?.mpesaReceipt ? ` Receipt: ${data.result.mpesaReceipt}` : '';
          const fundingSuffix = data.funding?.newBalance !== undefined
            ? ` New balance: KSH ${Number(data.funding.newBalance).toLocaleString()}`
            : '';
          setDarajaTestMessage(`STK test completed successfully.${receipt}${fundingSuffix}`);
          stopDarajaTestPolling();
          return;
        }

        if (data.status === 'failed') {
          setDarajaTestMessage(data.result?.resultDesc || data.result?.ResultDesc || 'Daraja test payment failed');
          stopDarajaTestPolling();
          return;
        }

        if (data.status === 'cancelled') {
          setDarajaTestMessage(data.result?.resultDesc || data.result?.ResultDesc || 'STK request was cancelled by user');
          stopDarajaTestPolling();
          return;
        }

        setDarajaTestMessage(data.result?.ResultDesc || data.result?.resultDesc || 'Waiting for customer action on phone...');

        if (attempts >= maxAttempts) {
          setDarajaTestStatus('pending');
          setDarajaTestMessage('STK push sent. Status polling stopped after timeout; you can retry status check if needed.');
          stopDarajaTestPolling();
        }
      } catch (error) {
        if (attempts >= maxAttempts) {
          setDarajaTestStatus('failed');
          setDarajaTestMessage(error instanceof Error ? error.message : 'Failed to poll Daraja test status');
          stopDarajaTestPolling();
        }
      }
    };

    // Check immediately once, then continue with short polling interval.
    runStatusCheck();
    darajaTestIntervalRef.current = setInterval(runStatusCheck, 1500);
  };

  const handleAdminDarajaTestDeposit = async () => {
    const trimmedPhone = darajaTestPhone.trim();
    const parsedAmount = parseFloat(darajaTestAmount);

    if (!trimmedPhone) {
      alert('Enter an M-Pesa number for testing');
      return;
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
      alert('Enter a valid amount greater than 0');
      return;
    }

    setIsDarajaTesting(true);
    setDarajaTestStatus('pending');
    setDarajaTestMessage('Sending STK push request to Daraja...');

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
      const response = await fetch(`${apiUrl}/api/admin/daraja-test/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loggedInUser?.phone || '',
          phoneNumber: trimmedPhone,
          amount: parsedAmount,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to initiate admin Daraja test deposit');
      }

      setDarajaTestSession(data.testPayment);
      setDarajaTestMessage(data.message || 'STK push sent. Checking status every 1.5 seconds...');
      pollDarajaTestStatus(data.testPayment.checkoutRequestId);
    } catch (error) {
      setDarajaTestStatus('failed');
      setDarajaTestMessage(error instanceof Error ? error.message : 'Failed to initiate Daraja test deposit');
      stopDarajaTestPolling();
    } finally {
      setIsDarajaTesting(false);
    }
  };

  const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold uppercase tracking-wider text-foreground">
              <Settings className="mr-2 inline h-6 w-6 text-primary" />
              Admin Portal
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage games, users, and withdrawals</p>
          </div>
          <Button variant="hero" size="sm" onClick={() => setShowDarajaTestModal(true)}>
            <ArrowDown className="mr-2 h-4 w-4" /> Test STK Push
          </Button>
        </div>

        <Dialog
          open={showDarajaTestModal}
          onOpenChange={(open) => {
            setShowDarajaTestModal(open);
            if (!open) {
              stopDarajaTestPolling();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Admin Daraja Test Deposit</DialogTitle>
              <DialogDescription>
                This is isolated from the live deposit flow. It only sends a direct Daraja STK push for admin testing.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">M-Pesa Number</label>
                <Input
                  value={darajaTestPhone}
                  onChange={(e) => setDarajaTestPhone(e.target.value)}
                  placeholder="07XXXXXXXX or 2547XXXXXXXX"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Amount (KSH)</label>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={darajaTestAmount}
                  onChange={(e) => setDarajaTestAmount(e.target.value)}
                  placeholder="100"
                />
              </div>

              <Button variant="hero" className="w-full" disabled={isDarajaTesting} onClick={handleAdminDarajaTestDeposit}>
                {isDarajaTesting ? 'Sending STK Push...' : 'Send Test Deposit'}
              </Button>

              {darajaTestStatus && (
                <Card className="border-border bg-card p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
                  <p className={`mt-1 text-sm font-semibold ${darajaTestStatus === 'success' ? 'text-primary' : darajaTestStatus === 'cancelled' ? 'text-orange-500' : darajaTestStatus === 'failed' ? 'text-destructive' : 'text-gold'}`}>
                    {darajaTestStatus.toUpperCase()}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{darajaTestMessage}</p>

                  {darajaTestSession && (
                    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                      <p>Reference: <span className="font-mono text-foreground">{darajaTestSession.externalReference}</span></p>
                      <p>Checkout ID: <span className="break-all font-mono text-foreground">{darajaTestSession.checkoutRequestId}</span></p>
                      <p>Phone: <span className="font-mono text-foreground">{darajaTestSession.phoneNumber}</span></p>
                      <p>Amount: <span className="font-mono text-foreground">KSH {Number(darajaTestSession.amount).toLocaleString()}</span></p>
                    </div>
                  )}
                </Card>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Stats */}
        <div className="mb-8 grid gap-4 md:grid-cols-6">
          {stats.slice(0, 1).map((s) => (
            <div key={s.label} className="gradient-card rounded-xl border border-border/50 p-5 card-glow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className={`mt-1 font-display text-2xl font-bold ${s.color}`}>{s.value}</p>
                  {s.note && <p className="mt-1 text-[11px] text-muted-foreground">{s.note}</p>}
                </div>
                <s.icon className={`h-8 w-8 ${s.color} opacity-30`} />
              </div>
            </div>
          ))}
          <ActiveMembers />
          {stats.slice(1).map((s) => (
            <div key={s.label} className="gradient-card rounded-xl border border-border/50 p-5 card-glow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className={`mt-1 font-display text-2xl font-bold ${s.color}`}>{s.value}</p>
                  {s.note && <p className="mt-1 text-[11px] text-muted-foreground">{s.note}</p>}
                </div>
                <s.icon className={`h-8 w-8 ${s.color} opacity-30`} />
              </div>
            </div>
          ))}
        </div>

        <Tabs value={adminTab} onValueChange={handleTabChange}>
          <TabsList className="mb-6 bg-secondary grid w-full grid-cols-7">
            <TabsTrigger value="games" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Trophy className="mr-1 h-4 w-4" /> Games
            </TabsTrigger>
            <TabsTrigger value="events" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Calendar className="mr-1 h-4 w-4" /> Events
            </TabsTrigger>
            <TabsTrigger value="users" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Users className="mr-1 h-4 w-4" /> Users
            </TabsTrigger>
            <TabsTrigger value="broadcast" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Megaphone className="mr-1 h-4 w-4" /> Broadcast
            </TabsTrigger>
            <TabsTrigger value="earnings" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <BarChart3 className="mr-1 h-4 w-4" /> Earnings
            </TabsTrigger>
            <TabsTrigger value="transactions" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <DollarSign className="mr-1 h-4 w-4" /> Transactions
            </TabsTrigger>
            <TabsTrigger value="bets" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Trophy className="mr-1 h-4 w-4" /> Bets
            </TabsTrigger>
          </TabsList>

          <TabsContent value="games">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">Manage Games</h3>
              <div className="flex gap-2">
                <Button variant="hero" size="sm" onClick={() => setShowFetchGamesModal(true)}>
                  <Download className="mr-1 h-4 w-4" /> Fetch from API Football
                </Button>
                <Button variant="hero" size="sm" onClick={() => { setShowImageImport(!showImageImport); setShowAddGame(false); setImportResult(null); }}>
                  <ImageIcon className="mr-1 h-4 w-4" /> Import from Image
                </Button>
                <Button variant="hero" size="sm" onClick={() => { setShowAddGame(!showAddGame); setShowImageImport(false); }}>
                  <Plus className="mr-1 h-4 w-4" /> Add Fixture
                </Button>
              </div>
            </div>

            {showImageImport && (
              <div className="mb-6 animate-fade-up rounded-xl border border-primary/30 bg-card p-6 neon-border">
                <h4 className="mb-2 font-display text-sm font-bold uppercase text-foreground">Import Games from Image</h4>
                <p className="mb-4 text-xs text-muted-foreground">Upload a screenshot of betting odds. The system reads team names, odds, kickoff times, and leagues — then you can review, edit, and add them.</p>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImageImport(file);
                  }}
                />

                {/* Upload area — show only if no parsed games yet */}
                {parsedImportGames.length === 0 && (
                  <div
                    className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-primary/40 bg-background/50 p-8 transition hover:border-primary/70 hover:bg-background/80"
                    onClick={() => !importingImage && imageInputRef.current?.click()}
                  >
                    {importingImage ? (
                      <>
                        <Loader2 className="h-10 w-10 animate-spin text-primary" />
                        <p className="mt-3 text-sm font-medium text-primary">Reading image... {ocrProgress}%</p>
                        <div className="mt-2 h-2 w-48 overflow-hidden rounded-full bg-background">
                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${ocrProgress}%` }} />
                        </div>
                      </>
                    ) : (
                      <>
                        <Upload className="h-10 w-10 text-muted-foreground" />
                        <p className="mt-3 text-sm font-medium text-foreground">Click to upload or paste an image</p>
                        <p className="mt-1 text-xs text-muted-foreground">PNG, JPG, or screenshot — you can also Ctrl+V to paste</p>
                      </>
                    )}
                  </div>
                )}

                {importResult && (
                  <div className={`mt-4 rounded-lg p-3 text-sm ${importResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    {importResult.message}
                  </div>
                )}

                {ocrRawText && (
                  <div className="mt-3">
                    <button
                      className="text-xs text-muted-foreground underline hover:text-foreground"
                      onClick={() => setShowRawText(!showRawText)}
                    >
                      {showRawText ? 'Hide' : 'Show'} raw OCR text (debug)
                    </button>
                    {showRawText && (
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-background/80 p-3 text-[10px] text-muted-foreground border border-border/30">
                        {ocrRawText}
                      </pre>
                    )}
                  </div>
                )}

                {/* Parsed games preview cards */}
                {parsedImportGames.length > 0 && (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">{parsedImportGames.filter(g => !g.saved).length} game(s) ready</span>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={addEmptyImportGame}>
                          <Plus className="mr-1 h-3 w-3" /> Add Missing Game
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => imageInputRef.current?.click()}>
                          <Upload className="mr-1 h-3 w-3" /> New Image
                        </Button>
                        {parsedImportGames.some(g => !g.saved) && (
                          <Button variant="hero" size="sm" onClick={executeAllImportGames}>
                            <Zap className="mr-1 h-3 w-3" /> Execute All
                          </Button>
                        )}
                      </div>
                    </div>

                    {parsedImportGames.map((pg, idx) => (
                      <div key={pg.id} className={`rounded-lg border p-4 ${pg.saved ? 'border-green-500/40 bg-green-500/5' : 'border-border/50 bg-background/50'}`}>
                        {pg.saved ? (
                          <div className="flex items-center gap-2 text-green-400">
                            <CheckCircle className="h-4 w-4" />
                            <span className="text-sm font-medium">{pg.homeTeam} vs {pg.awayTeam} — Added!</span>
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div>
                                <label className="text-[10px] uppercase text-muted-foreground">League</label>
                                <input className={inputClass} value={pg.league} onChange={(e) => updateImportGame(idx, 'league', e.target.value)} />
                              </div>
                              <div>
                                <label className="text-[10px] uppercase text-muted-foreground">Kickoff</label>
                                <input type="datetime-local" className={inputClass} value={pg.kickoffDateTime} onChange={(e) => updateImportGame(idx, 'kickoffDateTime', e.target.value)} />
                              </div>
                              <div>
                                <label className="text-[10px] uppercase text-muted-foreground">Home Team</label>
                                <input className={inputClass} value={pg.homeTeam} onChange={(e) => updateImportGame(idx, 'homeTeam', e.target.value)} />
                              </div>
                              <div>
                                <label className="text-[10px] uppercase text-muted-foreground">Away Team</label>
                                <input className={inputClass} value={pg.awayTeam} onChange={(e) => updateImportGame(idx, 'awayTeam', e.target.value)} />
                              </div>
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <label className="text-[10px] uppercase text-muted-foreground">1</label>
                                  <input className={inputClass} value={pg.homeOdds} onChange={(e) => updateImportGame(idx, 'homeOdds', e.target.value)} />
                                </div>
                                <div className="flex-1">
                                  <label className="text-[10px] uppercase text-muted-foreground">X</label>
                                  <input className={inputClass} value={pg.drawOdds} onChange={(e) => updateImportGame(idx, 'drawOdds', e.target.value)} />
                                </div>
                                <div className="flex-1">
                                  <label className="text-[10px] uppercase text-muted-foreground">2</label>
                                  <input className={inputClass} value={pg.awayOdds} onChange={(e) => updateImportGame(idx, 'awayOdds', e.target.value)} />
                                </div>
                              </div>
                              <div className="flex items-end gap-2">
                                <Button variant="hero" size="sm" className="flex-1" onClick={() => executeImportGame(idx)} disabled={pg.saving}>
                                  {pg.saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
                                  {pg.saving ? 'Adding...' : 'Add Game'}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => removeImportGame(idx)}>
                                  <Trash2 className="h-4 w-4 text-red-400" />
                                </Button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4 flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setShowImageImport(false); setImportResult(null); setParsedImportGames([]); setOcrRawText(''); }}>Close</Button>
                </div>
              </div>
            )}

            {showAddGame && (
              <div className="mb-6 animate-fade-up rounded-xl border border-primary/30 bg-card p-6 neon-border">
                <h4 className="mb-2 font-display text-sm font-bold uppercase text-foreground">New Fixture</h4>
                <p className="mb-4 text-xs text-muted-foreground">Enter 1X2 odds and optionally set all other market odds. Leave market fields empty to skip them.</p>
                
                {/* Basic Game Info */}
                <div className="mb-4 pb-4 border-b border-border/50">
                  <h5 className="mb-3 text-xs font-semibold text-muted-foreground uppercase">Match Details</h5>
                  <div className="grid gap-4 md:grid-cols-2">
                    <input className={inputClass} placeholder="League (e.g. Premier League)" value={newGame.league} onChange={(e) => setNewGame({ ...newGame, league: e.target.value })} />
                    <div>
                      <label className="text-xs text-muted-foreground">Kickoff Date & Time</label>
                      <input type="datetime-local" className={inputClass} value={newGame.kickoffDateTime} onChange={(e) => setNewGame({ ...newGame, kickoffDateTime: e.target.value })} />
                    </div>
                    <input className={inputClass} placeholder="Home Team" value={newGame.homeTeam} onChange={(e) => setNewGame({ ...newGame, homeTeam: e.target.value })} />
                    <input className={inputClass} placeholder="Away Team" value={newGame.awayTeam} onChange={(e) => setNewGame({ ...newGame, awayTeam: e.target.value })} />
                    <select className={inputClass} value={newGame.status} onChange={(e) => setNewGame({ ...newGame, status: e.target.value as "upcoming" | "live" | "finished" })}>
                      <option value="upcoming">Upcoming</option>
                      <option value="live">Live</option>
                      <option value="finished">Finished</option>
                    </select>
                  </div>
                </div>

                {/* 1X2 Odds (Required) */}
                <div className="mb-4 pb-4 border-b border-border/50">
                  <h5 className="mb-3 text-xs font-semibold text-muted-foreground uppercase">1X2 Odds (Required)</h5>
                  <div className="grid gap-4 md:grid-cols-3">
                    <input className={inputClass} type="number" placeholder="Home Odds (1)" value={newGame.homeOdds} onChange={(e) => setNewGame({ ...newGame, homeOdds: e.target.value })} step="0.01" min="1" />
                    <input className={inputClass} type="number" placeholder="Draw Odds (X)" value={newGame.drawOdds} onChange={(e) => setNewGame({ ...newGame, drawOdds: e.target.value })} step="0.01" min="1" />
                    <input className={inputClass} type="number" placeholder="Away Odds (2)" value={newGame.awayOdds} onChange={(e) => setNewGame({ ...newGame, awayOdds: e.target.value })} step="0.01" min="1" />
                  </div>
                </div>

                {/* Additional Markets (Optional) */}
                <div>
                  <h5 className="mb-3 text-xs font-semibold text-muted-foreground uppercase">Additional Markets (Optional)</h5>
                  <p className="mb-3 text-[10px] text-muted-foreground">Leave fields empty to skip these markets</p>
                  <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
                    {/* BTTS */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">BTTS Yes</label>
                      <input type="number" className={inputClass} value={newGame.markets?.bttsYes || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, bttsYes: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">BTTS No</label>
                      <input type="number" className={inputClass} value={newGame.markets?.bttsNo || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, bttsNo: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    
                    {/* Over/Under 2.5 */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">Over 2.5</label>
                      <input type="number" className={inputClass} value={newGame.markets?.over25 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, over25: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">Under 2.5</label>
                      <input type="number" className={inputClass} value={newGame.markets?.under25 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, under25: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    
                    {/* Over/Under 1.5 */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">Over 1.5</label>
                      <input type="number" className={inputClass} value={newGame.markets?.over15 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, over15: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">Under 1.5</label>
                      <input type="number" className={inputClass} value={newGame.markets?.under15 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, under15: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    
                    {/* Double Chance */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">DC 1X</label>
                      <input type="number" className={inputClass} value={newGame.markets?.doubleChanceHomeOrDraw || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, doubleChanceHomeOrDraw: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">DC X2</label>
                      <input type="number" className={inputClass} value={newGame.markets?.doubleChanceAwayOrDraw || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, doubleChanceAwayOrDraw: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">DC 12</label>
                      <input type="number" className={inputClass} value={newGame.markets?.doubleChanceHomeOrAway || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, doubleChanceHomeOrAway: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    
                    {/* HT/FT */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">HT/FT H/H</label>
                      <input type="number" className={inputClass} value={newGame.markets?.htftHomeHome || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, htftHomeHome: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">HT/FT D/D</label>
                      <input type="number" className={inputClass} value={newGame.markets?.htftDrawDraw || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, htftDrawDraw: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">HT/FT A/A</label>
                      <input type="number" className={inputClass} value={newGame.markets?.htftAwayAway || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, htftAwayAway: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    
                    {/* Correct Score - sample few for space */}
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 0-0</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs00 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs00: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 1-0</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs10 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs10: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 1-1</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs11 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs11: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 2-0</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs20 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs20: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 2-1</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs21 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs21: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-muted-foreground mb-1">CS 2-2</label>
                      <input type="number" className={inputClass} value={newGame.markets?.cs22 || ""} onChange={(e) => setNewGame({ ...newGame, markets: { ...newGame.markets, cs22: e.target.value } })} placeholder="1.50" step="0.01" min="1" />
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button variant="hero" size="sm" onClick={addGameHandler}>
                    <Plus className="mr-1 h-3 w-3" /> Add Fixture
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowAddGame(false)}>Cancel</Button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {/* ── Select-all / bulk-delete toolbar (upcoming + live games only) ── */}
              {(() => {
                const selectableGames = sortGamesByKickoffTime(games).filter(g => g.status === 'upcoming' || g.status === 'live');
                const allSelected = selectableGames.length > 0 && selectableGames.every(g => markedGames.has(g.id));
                const someSelected = markedGames.size > 0;
                if (selectableGames.length === 0) return null;
                return (
                  <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
                    <input
                      type="checkbox"
                      id="select-all-upcoming"
                      className="h-4 w-4 cursor-pointer accent-primary"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) {
                          const next = new Set(markedGames);
                          selectableGames.forEach(g => next.delete(g.id));
                          setMarkedGames(next);
                        } else {
                          setMarkedGames(new Set([...markedGames, ...selectableGames.map(g => g.id)]));
                        }
                      }}
                    />
                    <label htmlFor="select-all-upcoming" className="cursor-pointer text-xs text-muted-foreground select-none">
                      {allSelected ? 'Deselect all' : `Select all upcoming (${selectableGames.length})`}
                    </label>
                    {someSelected && (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="ml-auto h-7 text-xs"
                        onClick={deleteMarkedGames}
                        disabled={deletingMarkedGames}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        {deletingMarkedGames ? 'Deleting…' : `Delete ${markedGames.size} selected`}
                      </Button>
                    )}
                  </div>
                );
              })()}

              {sortGamesByKickoffTime(games).map((game) => (
                <div key={game.id} className="rounded-xl border border-border/50 bg-card p-4">
                  {isApiManagedGame(game.id) && (
                    <div className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-300">
                      API-managed match. Scores, status and odds sync automatically from API-Football. Admin editing is disabled.
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    {/* Checkbox — only for upcoming/live games */}
                    {(game.status === 'upcoming' || game.status === 'live') && (
                      <input
                        type="checkbox"
                        className="mr-3 h-4 w-4 flex-shrink-0 cursor-pointer accent-primary"
                        checked={markedGames.has(game.id)}
                        onChange={() => {
                          const next = new Set(markedGames);
                          next.has(game.id) ? next.delete(game.id) : next.add(game.id);
                          setMarkedGames(next);
                        }}
                      />
                    )}
                    {game.status === 'finished' && <div className="mr-3 w-4 flex-shrink-0" />}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{game.league}</span>
                        <Badge variant={game.status === "live" ? "live" : game.status === "finished" ? "secondary" : "default"} className="text-[10px]">
                          {game.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-foreground">
                        {game.homeTeam} vs {game.awayTeam}
                      </p>
                      <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                        <span>1: <span className="font-mono font-bold text-primary">{game.homeOdds.toFixed(2)}</span></span>
                        <span>X: <span className="font-mono font-bold text-primary">{game.drawOdds.toFixed(2)}</span></span>
                        <span>2: <span className="font-mono font-bold text-primary">{game.awayOdds.toFixed(2)}</span></span>
                        <span>📅 {game.time}</span>
                      </div>

                      {/* Edit Game Details Button */}
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isApiManagedGame(game.id)}
                          onClick={() => {
                            setEditingGameDetails(editingGameDetails === game.id ? null : game.id);
                            if (editingGameDetails !== game.id) {
                              // Safely parse the kickoff time
                              let kickoffTimeStr = game.time || new Date().toISOString();
                              try {
                                // Try to parse as date
                                const parsedDate = new Date(kickoffTimeStr);
                                if (isNaN(parsedDate.getTime())) {
                                  kickoffTimeStr = new Date().toISOString();
                                }
                              } catch (e) {
                                kickoffTimeStr = new Date().toISOString();
                              }
                              
                              // Initialize markets: start with ALL marketLabels keys + any DB values
                              const dbMarkets = game.markets || {};
                              const editableMarkets: Record<string, number> = { ...dbMarkets };
                              // Ensure every marketLabels key exists in state so edits are tracked
                              for (const k of Object.keys(marketLabels)) {
                                if (editableMarkets[k] === undefined || editableMarkets[k] === null) {
                                  // leave absent — will show as empty input
                                } else {
                                  editableMarkets[k] = editableMarkets[k]; // keep DB value
                                }
                              }
                              
                              setGameDetailsEdit({
                                ...gameDetailsEdit,
                                [game.id]: {
                                  league: game.league,
                                  homeTeam: game.homeTeam,
                                  awayTeam: game.awayTeam,
                                  homeOdds: game.homeOdds.toString(),
                                  drawOdds: game.drawOdds.toString(),
                                  awayOdds: game.awayOdds.toString(),
                                  kickoffTime: kickoffTimeStr,
                                  markets: editableMarkets
                                }
                              });
                            }
                          }}
                          className="text-xs"
                        >
                          <Edit2 className="mr-1 h-3 w-3" />
                          {editingGameDetails === game.id ? "Close Edit" : "Edit Details"}
                        </Button>
                      </div>

                      {/* Game Details Edit Form */}
                      {editingGameDetails === game.id && (
                        <div className="mt-3 space-y-2 rounded-lg border border-border/50 bg-background/50 p-3">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-muted-foreground">League</label>
                              <Input
                                value={gameDetailsEdit[game.id]?.league || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], league: v } })); }}
                                className="h-7 text-xs"
                                placeholder="League"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground">Kickoff Time</label>
                              <Input
                                type="datetime-local"
                                value={
                                  gameDetailsEdit[game.id]?.kickoffTime 
                                    ? (() => {
                                        try {
                                          const date = new Date(gameDetailsEdit[game.id].kickoffTime);
                                          if (isNaN(date.getTime())) return "";
                                          return date.toISOString().slice(0, 16);
                                        } catch (e) {
                                          return "";
                                        }
                                      })()
                                    : ""
                                }
                                onChange={(e) => {
                                  if (e.target.value) {
                                    try {
                                      const newDate = new Date(e.target.value + ':00').toISOString();
                                      setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], kickoffTime: newDate } }));
                                    } catch (err) {
                                      console.error('Error parsing date:', err);
                                    }
                                  }
                                }}
                                className="h-7 text-xs"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-muted-foreground">Home Team</label>
                              <Input
                                value={gameDetailsEdit[game.id]?.homeTeam || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], homeTeam: v } })); }}
                                className="h-7 text-xs"
                                placeholder="Home Team"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground">Away Team</label>
                              <Input
                                value={gameDetailsEdit[game.id]?.awayTeam || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], awayTeam: v } })); }}
                                className="h-7 text-xs"
                                placeholder="Away Team"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="text-xs text-muted-foreground">Home Odds (1)</label>
                              <Input
                                type="number"
                                min="1"
                                step="0.01"
                                value={gameDetailsEdit[game.id]?.homeOdds || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], homeOdds: v } })); }}
                                className="h-7 text-xs"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground">Draw (X)</label>
                              <Input
                                type="number"
                                min="1"
                                step="0.01"
                                value={gameDetailsEdit[game.id]?.drawOdds || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], drawOdds: v } })); }}
                                className="h-7 text-xs"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground">Away (2)</label>
                              <Input
                                type="number"
                                min="1"
                                step="0.01"
                                value={gameDetailsEdit[game.id]?.awayOdds || ""}
                                onChange={(e) => { const v = e.target.value; setGameDetailsEdit(prev => ({ ...prev, [game.id]: { ...prev[game.id], awayOdds: v } })); }}
                                className="h-7 text-xs"
                              />
                            </div>
                          </div>

                          {/* Market Odds Editor */}
                          {gameDetailsEdit[game.id]?.markets && (
                            <div className="mt-3 border-t border-border/30 pt-3">
                              <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase">All Market Odds</p>
                              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
                                {(Object.keys(marketLabels) as (keyof typeof marketLabels)[]).map((key) => {
                                  const currentDbValue = game.markets?.[key];
                                  const editValue = gameDetailsEdit[game.id]?.markets?.[key];
                                  const hasChanged = currentDbValue && editValue && Math.abs(currentDbValue - editValue) > 0.01;
                                  
                                  return (
                                    <div key={key}>
                                      <label className="block text-[10px] text-muted-foreground mb-0.5">
                                        {marketLabels[key]}
                                        {currentDbValue && <span className="text-primary font-semibold"> ({currentDbValue.toFixed(2)})</span>}
                                      </label>
                                      <input
                                        type="number"
                                        step="0.01"
                                        className={`w-full rounded border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary ${
                                          hasChanged ? 'border-yellow-500/50 bg-yellow-500/5' : 'border-border'
                                        }`}
                                        value={editValue != null && editValue !== 0 ? editValue : ''}
                                        placeholder={currentDbValue?.toFixed(2) || '1.50'}
                                        onChange={(e) => {
                                          const raw = e.target.value;
                                          const parsed = raw === '' ? undefined : parseFloat(raw);
                                          const newValue = parsed !== undefined && !isNaN(parsed) ? parsed : undefined;
                                          setGameDetailsEdit(prev => ({
                                            ...prev,
                                            [game.id]: {
                                              ...prev[game.id],
                                              markets: {
                                                ...prev[game.id]?.markets,
                                                [key]: newValue as any
                                              }
                                            }
                                          }));
                                        }}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="hero"
                              onClick={() => updateGameDetails(game.id)}
                              className="text-xs flex-1"
                            >
                              <Save className="mr-1 h-3 w-3" /> Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingGameDetails(null)}
                              className="text-xs flex-1"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      
                      {/* Score Update Section for Live/Finished Games */}
                      {(game.status === "live" || game.status === "finished") && (
                        <div className="mt-4 space-y-3 rounded-lg border border-border/50 bg-background/50 p-3">
                          {/* Live Play Status */}
                          {game.status === "live" && (
                            <div className="grid grid-cols-2 gap-2">
                              <div className="text-center">
                                <p className="text-xs text-muted-foreground">Minute</p>
                                <p className="text-lg font-bold text-primary">{String(Math.floor(game.minute ?? 0)).padStart(2, "0")}:{String(Math.floor(game.seconds ?? 0)).padStart(2, "0")}'</p>
                                {game.gamePaused && game.minute === 45 && (
                                  <p className="text-xs text-gold font-semibold">HALFTIME</p>
                                )}
                              </div>
                              <div className="text-center">
                                <p className="text-xs text-muted-foreground">Score</p>
                                <p className="text-lg font-bold">{game.homeScore ?? 0} - {game.awayScore ?? 0}</p>
                              </div>
                            </div>
                          )}

                          {/* Custom Time Setter */}
                          {game.status === "live" && (
                            <div className="space-y-2 pt-2 border-t border-border/30">
                              <p className="text-xs text-muted-foreground font-semibold">Set Custom Time:</p>
                              <div className="flex gap-1">
                                <Input
                                  type="number"
                                  min="0"
                                  max="120"
                                  placeholder="Minute"
                                  className="h-7 w-16 text-xs"
                                  value={customTimeSettings[`${game.id}_minute`] ?? Math.floor(game.minute ?? 0)}
                                  onChange={(e) => {
                                    const nextMinute = parseInt(e.target.value, 10);
                                    setCustomTimeSettings((prev) => ({
                                      ...prev,
                                      [`${game.id}_minute`]: Number.isFinite(nextMinute) ? nextMinute : 0
                                    }));
                                  }}
                                  onKeyPress={(e) => {
                                    if (e.key === 'Enter') {
                                      const minute = parseInt((e.target as HTMLInputElement).value) || 0;
                                      const seconds = customTimeSettings[`${game.id}_seconds`] ?? Math.floor(game.seconds ?? 0);
                                      setCustomGameTime(game.id, minute, seconds);
                                    }
                                  }}
                                />
                                <Input
                                  type="number"
                                  min="0"
                                  max="59"
                                  placeholder="Seconds"
                                  className="h-7 w-16 text-xs"
                                  value={customTimeSettings[`${game.id}_seconds`] ?? Math.floor(game.seconds ?? 0)}
                                  onChange={(e) => {
                                    const parsedSeconds = parseInt(e.target.value, 10);
                                    const clampedSeconds = Number.isFinite(parsedSeconds)
                                      ? Math.max(0, Math.min(59, parsedSeconds))
                                      : 0;
                                    setCustomTimeSettings((prev) => ({
                                      ...prev,
                                      [`${game.id}_seconds`]: clampedSeconds
                                    }));
                                  }}
                                />
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => {
                                    const minute = customTimeSettings[`${game.id}_minute`] ?? Math.floor(game.minute ?? 0);
                                    const seconds = customTimeSettings[`${game.id}_seconds`] ?? Math.floor(game.seconds ?? 0);
                                    setCustomGameTime(game.id, minute, seconds);
                                  }}
                                  className="text-xs"
                                >
                                  <Clock className="mr-1 h-3 w-3" />Set
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Live Play Controls */}
                          <div className="flex flex-wrap gap-2">
                            {game.status === "upcoming" && (
                              <Button
                                size="sm"
                                variant="hero"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => markGameLive(game.id)}
                                className="text-xs"
                              >
                                Mark Live
                              </Button>
                            )}
                            
                            {game.status === "live" && !game.isKickoffStarted && (
                              <Button
                                size="sm"
                                variant="hero"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => startKickoff(game.id)}
                                className="text-xs"
                              >
                                <Play className="mr-1 h-3 w-3" /> Kickoff
                              </Button>
                            )}

                            {game.status === "live" && game.isKickoffStarted && !game.gamePaused && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => pauseKickoff(game.id)}
                                className="text-xs"
                              >
                                <Pause className="mr-1 h-3 w-3" /> Pause
                              </Button>
                            )}

                            {game.status === "live" && game.isKickoffStarted && game.gamePaused && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => resumeKickoff(game.id)}
                                className="text-xs"
                              >
                                <Play className="mr-1 h-3 w-3" /> Resume
                              </Button>
                            )}

                            {game.status === "live" && !game.isHalftime && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => markHalftime(game.id)}
                                className="text-xs"
                              >
                                ⏱️ Halftime
                              </Button>
                            )}

                            {game.status === "live" && game.isHalftime && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => resumeSecondHalf(game.id)}
                                className="text-xs"
                              >
                                ▶️ Resume 2nd Half
                              </Button>
                            )}

                            {game.status === "live" && (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => endGame(game.id)}
                                className="text-xs"
                              >
                                <Square className="mr-1 h-3 w-3" /> End Game
                              </Button>
                            )}

                            {game.status === "finished" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => revertGame(game.id)}
                                className="text-xs"
                                title="Revert finished game back to live and unsettle all bets"
                              >
                                <RefreshCw className="mr-1 h-3 w-3" /> Revert to Live
                              </Button>
                            )}
                          </div>

                          {/* Score Control */}
                          <div className="flex flex-wrap gap-2">
                            <div className="flex gap-1">
                              <div>
                                <label className="text-xs text-muted-foreground">Home</label>
                                <Input
                                  type="number"
                                  min="0"
                                  max="20"
                                  className="w-16 h-8 px-2"
                                  value={scoreUpdate[game.id]?.home ?? game.homeScore ?? 0}
                                  onChange={(e) => setScoreUpdate({ ...scoreUpdate, [game.id]: { ...(scoreUpdate[game.id] || { home: 0, away: 0 }), home: parseInt(e.target.value) || 0 } })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-muted-foreground">Away</label>
                                <Input
                                  type="number"
                                  min="0"
                                  max="20"
                                  className="w-16 h-8 px-2"
                                  value={scoreUpdate[game.id]?.away ?? game.awayScore ?? 0}
                                  onChange={(e) => setScoreUpdate({ ...scoreUpdate, [game.id]: { ...(scoreUpdate[game.id] || { home: 0, away: 0 }), away: parseInt(e.target.value) || 0 } })}
                                />
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isApiManagedGame(game.id)}
                                onClick={() => {
                                  const score = scoreUpdate[game.id];
                                  if (score) {
                                    updateLiveScore(game.id, score.home, score.away);
                                  }
                                }}
                                className="text-xs h-8"
                              >
                                Update
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {game.status === "upcoming" && (
                        <Button 
                          variant="hero" 
                          size="sm"
                          disabled={isApiManagedGame(game.id)}
                          onClick={() => markGameLive(game.id)}
                          className="text-xs"
                          title="Mark this match as live"
                        >
                          Mark Live
                        </Button>
                      )}
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={() => {
                          setSelectedGameForEvents({
                            id: game.id,
                            name: `${game.homeTeam} vs ${game.awayTeam}`,
                            kickoffTime: game.time,
                          });
                          setAdminTab("events");
                        }}
                        title="Configure automated match events"
                        className="border-primary/50 hover:bg-primary/10"
                      >
                        <Zap className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => toggleHot(game.id)} title={game.isHot ? "Unmark as Hot" : "Mark as Hot"}>
                        <Flame className={`h-4 w-4 ${game.isHot ? 'text-orange-500 fill-orange-500' : 'text-muted-foreground'}`} />
                      </Button>
                      <Button variant="ghost" size="icon" disabled={isApiManagedGame(game.id)} onClick={() => regenerateOdds(game.id)} title={isApiManagedGame(game.id) ? "API-managed matches sync automatically" : "Regenerate all market odds"}>
                        <RefreshCw className="h-4 w-4 text-primary" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => removeGameHandler(game.id)} className="text-destructive hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                </div>
              ))}
              {games.length === 0 && (
                <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-muted-foreground">
                  No games added yet. Click "Add Fixture" to get started.
                </div>
              )}
            </div>

            {/* Delete API Games Section */}
            <div className="mt-12 space-y-4 rounded-xl border border-red-500/30 bg-red-500/5 p-6">
              <h4 className="font-display text-sm font-bold uppercase tracking-wider text-red-500 flex items-center gap-2">
                <Trash2 className="h-4 w-4" /> Delete API-Fetched Games by Date
              </h4>
              <p className="text-xs text-muted-foreground">Select and delete API-fetched matches (not admin-added ones) by their kickoff date.</p>
              
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={gameDeleteDateFilter}
                  onChange={(e) => setGameDeleteDateFilter(e.target.value)}
                  className="max-w-xs"
                />
              </div>

              {(() => {
                // Get all API-managed games and filter by date
                const apiGames = games.filter(g => g.game_id && String(g.game_id).startsWith('af-'));
                const filteredGames = gameDeleteDateFilter
                  ? apiGames.filter(g => {
                      const gameDate = new Date(g.kickoffStartTime || g.time).toISOString().split('T')[0];
                      return gameDate === gameDeleteDateFilter;
                    })
                  : [];

                return (
                  <div className="space-y-4">
                    {filteredGames.length > 0 ? (
                      <>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-foreground">Found {filteredGames.length} API games for {gameDeleteDateFilter}</p>
                          {markedGames.size > 0 && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={deleteMarkedGames}
                              disabled={deletingMarkedGames}
                              className="text-xs"
                            >
                              <Trash2 className="mr-1 h-3 w-3" /> Delete {markedGames.size} Marked Games
                            </Button>
                          )}
                        </div>

                        <div className="overflow-x-auto rounded-lg border border-border/50">
                          <table className="w-full text-xs">
                            <thead className="bg-red-500/10 border-b border-red-500/30">
                              <tr className="text-red-500">
                                <th className="text-center p-2 font-semibold w-8">
                                  <input
                                    type="checkbox"
                                    checked={filteredGames.length > 0 && filteredGames.every(g => markedGames.has(g.id))}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setMarkedGames(new Set([...markedGames, ...filteredGames.map(g => g.id)]));
                                      } else {
                                        const newSet = new Set(markedGames);
                                        filteredGames.forEach(g => newSet.delete(g.id));
                                        setMarkedGames(newSet);
                                      }
                                    }}
                                    className="cursor-pointer"
                                  />
                                </th>
                                <th className="text-left p-2 font-semibold">League</th>
                                <th className="text-left p-2 font-semibold">Match</th>
                                <th className="text-center p-2 font-semibold">Kickoff Time</th>
                                <th className="text-center p-2 font-semibold">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {filteredGames.map((game) => (
                                <tr key={game.id} className="hover:bg-red-500/5 transition-colors">
                                  <td className="text-center p-2 w-8">
                                    <input
                                      type="checkbox"
                                      checked={markedGames.has(game.id)}
                                      onChange={() => toggleGameMark(game.id)}
                                      className="cursor-pointer"
                                    />
                                  </td>
                                  <td className="p-2 text-muted-foreground">{game.league || '-'}</td>
                                  <td className="p-2 text-foreground font-medium">{game.homeTeam} vs {game.awayTeam}</td>
                                  <td className="p-2 text-center text-muted-foreground">
                                    {new Date(game.kickoffStartTime || game.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                                  </td>
                                  <td className="p-2 text-center">
                                    <Badge variant="secondary" className="text-[10px]">{game.status}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : gameDeleteDateFilter ? (
                      <div className="rounded-lg border border-border/50 bg-card p-4 text-center text-sm text-muted-foreground">
                        No API games found for {gameDeleteDateFilter}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-border/50 bg-card p-4 text-center text-sm text-muted-foreground">
                        Select a date to view API-fetched games for deletion
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Delete All Games by Date Section */}
            <div className="mt-12 space-y-4 rounded-xl border border-orange-500/30 bg-orange-500/5 p-6">
              <h4 className="font-display text-sm font-bold uppercase tracking-wider text-orange-500 flex items-center gap-2">
                <Trash2 className="h-4 w-4" /> Delete All Games by Date
              </h4>
              <p className="text-xs text-muted-foreground">Warning: this includes admin-added matches. Use only when you intentionally want to remove every game on that date.</p>
              
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={allGamesDeleteDateFilter}
                  onChange={(e) => setAllGamesDeleteDateFilter(e.target.value)}
                  className="max-w-xs"
                />
              </div>

              {(() => {
                // Get all games and filter by date
                const filteredGames = allGamesDeleteDateFilter
                  ? games.filter(g => {
                      const gameDate = new Date(g.kickoffStartTime || g.time).toISOString().split('T')[0];
                      return gameDate === allGamesDeleteDateFilter;
                    })
                  : [];

                return (
                  <div className="space-y-4">
                    {filteredGames.length > 0 ? (
                      <>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-foreground">Found {filteredGames.length} games for {allGamesDeleteDateFilter}</p>
                          {markedGames.size > 0 && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={deleteMarkedGames}
                              disabled={deletingMarkedGames}
                              className="text-xs"
                            >
                              <Trash2 className="mr-1 h-3 w-3" /> Delete {markedGames.size} Marked Games
                            </Button>
                          )}
                        </div>

                        <div className="overflow-x-auto rounded-lg border border-border/50">
                          <table className="w-full text-xs">
                            <thead className="bg-orange-500/10 border-b border-orange-500/30">
                              <tr className="text-orange-500">
                                <th className="text-center p-2 font-semibold w-8">
                                  <input
                                    type="checkbox"
                                    checked={filteredGames.length > 0 && filteredGames.every(g => markedGames.has(g.id))}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setMarkedGames(new Set([...markedGames, ...filteredGames.map(g => g.id)]));
                                      } else {
                                        const newSet = new Set(markedGames);
                                        filteredGames.forEach(g => newSet.delete(g.id));
                                        setMarkedGames(newSet);
                                      }
                                    }}
                                    className="cursor-pointer"
                                  />
                                </th>
                                <th className="text-left p-2 font-semibold">Type</th>
                                <th className="text-left p-2 font-semibold">League</th>
                                <th className="text-left p-2 font-semibold">Match</th>
                                <th className="text-center p-2 font-semibold">Kickoff Time</th>
                                <th className="text-center p-2 font-semibold">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {filteredGames.map((game) => (
                                <tr key={game.id} className="hover:bg-orange-500/5 transition-colors">
                                  <td className="text-center p-2 w-8">
                                    <input
                                      type="checkbox"
                                      checked={markedGames.has(game.id)}
                                      onChange={() => toggleGameMark(game.id)}
                                      className="cursor-pointer"
                                    />
                                  </td>
                                  <td className="p-2 text-muted-foreground text-[10px] font-semibold">
                                    {game.game_id && String(game.game_id).startsWith('af-') ? '🔗 API' : '✏️ Manual'}
                                  </td>
                                  <td className="p-2 text-muted-foreground">{game.league || '-'}</td>
                                  <td className="p-2 text-foreground font-medium">{game.homeTeam} vs {game.awayTeam}</td>
                                  <td className="p-2 text-center text-muted-foreground">
                                    {new Date(game.kickoffStartTime || game.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                                  </td>
                                  <td className="p-2 text-center">
                                    <Badge variant="secondary" className="text-[10px]">{game.status}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : allGamesDeleteDateFilter ? (
                      <div className="rounded-lg border border-border/50 bg-card p-4 text-center text-sm text-muted-foreground">
                        No games found for {allGamesDeleteDateFilter}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-border/50 bg-card p-4 text-center text-sm text-muted-foreground">
                        Select a date to view all games (API + Admin) for deletion
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </TabsContent>

          <TabsContent value="events" className="space-y-6">
            {selectedGameForEvents ? (
              <div className="space-y-4">
                <Button
                  variant="outline"
                  onClick={() => setSelectedGameForEvents(null)}
                  className="mb-4"
                >
                  ← Back to Games
                </Button>
                <MatchEventEditor
                  gameId={selectedGameForEvents.id}
                  gameName={selectedGameForEvents.name}
                  kickoffTime={selectedGameForEvents.kickoffTime}
                  onClose={() => setSelectedGameForEvents(null)}
                  adminPhone={loggedInUser?.phone || ""}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">
                  Match Event Scheduler
                </h3>
                <p className="text-sm text-muted-foreground">
                  Select a game to configure automated match events for the fixture.
                </p>

                {games && games.length > 0 ? (
                  <div className="grid gap-3">
                    {games
                      .filter((game) => {
                        const id = game.id || game.game_id || '';
                        return (
                          !id.startsWith('af-') &&
                          !id.startsWith('ab-') &&
                          (game.status === 'upcoming' || game.status === 'live')
                        );
                      })
                      .map((game) => {
                        const homeTeam = game.homeTeam || game.home_team || 'Home';
                        const awayTeam = game.awayTeam || game.away_team || 'Away';
                        return (
                          <Card
                            key={game.id}
                            className="border-primary/20 bg-card/50 p-4 hover:border-primary/50 transition cursor-pointer"
                            onClick={() =>
                              setSelectedGameForEvents({
                                id: game.id,
                                name: `${homeTeam} vs ${awayTeam}`,
                                kickoffTime: game.time,
                              })
                            }
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-semibold">
                                  {homeTeam} vs {awayTeam}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatTimeInEAT(game.time)}
                                </p>
                              </div>
                              <Badge variant="outline">
                                {game.status === "live" && (
                                  <span className="text-green-400">LIVE</span>
                                )}
                                {game.status === "upcoming" && (
                                  <span className="text-blue-400">UPCOMING</span>
                                )}
                                {game.status === "finished" && (
                                  <span className="text-gray-400">FINISHED</span>
                                )}
                              </Badge>
                            </div>
                          </Card>
                        );
                      })}
                  </div>
                ) : (
                  <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-muted-foreground">
                    No games available. Create a game first in the Games tab.
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="users" className="space-y-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">Manage Users</h3>
            </div>
            
            <div className="mb-6">
              <Input
                placeholder="Search users by name, username, phone, email, or user ID..."
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                className="h-10"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {userSearchQuery && filteredUsers.length > 0 
                  ? `Found ${filteredUsers.length} user${filteredUsers.length !== 1 ? 's' : ''}` 
                  : userSearchQuery 
                  ? 'No users found' 
                  : `Showing all ${users.length} users`}
              </p>
            </div>

            <div className="space-y-3">
              {filteredUsers.map((user) => (
                <Card key={user.id} className="border-border bg-card p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {editingUserId === user.id ? (
                        <div className="space-y-3">
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Name</label>
                            <Input
                              value={editingUserData.name || user.name}
                              onChange={(e) => setEditingUserData({ ...editingUserData, name: e.target.value })}
                              className="mt-1 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Email</label>
                            <Input
                              value={editingUserData.email || user.email}
                              onChange={(e) => setEditingUserData({ ...editingUserData, email: e.target.value })}
                              className="mt-1 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Phone</label>
                            <Input
                              value={editingUserData.phone || user.phone}
                              onChange={(e) => setEditingUserData({ ...editingUserData, phone: e.target.value })}
                              className="mt-1 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Password (4 Digits)</label>
                            <Input
                              type="password"
                              inputMode="numeric"
                              maxLength={4}
                              value={editingUserData.password || user.password}
                              onChange={(e) => setEditingUserData({ ...editingUserData, password: e.target.value.replace(/\D/g, "") })}
                              className="mt-1 text-sm"
                            />
                            <p className="mt-1 text-xs text-muted-foreground">Must be 4 digits</p>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Account Balance (KSH)</label>
                            <Input
                              type="number"
                              value={editingUserData.accountBalance !== undefined ? editingUserData.accountBalance : user.accountBalance}
                              onChange={(e) => setEditingUserData({ ...editingUserData, accountBalance: parseFloat(e.target.value) || 0 })}
                              className="mt-1 text-sm"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="hero"
                              onClick={async () => {
                                try {
                                  const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';

                                  // If user details are being edited, call the backend API
                                  if (
                                    editingUserData.name !== undefined && editingUserData.name !== user.name ||
                                    editingUserData.email !== undefined && editingUserData.email !== user.email ||
                                    editingUserData.phone !== undefined && editingUserData.phone !== user.phone ||
                                    editingUserData.password !== undefined && editingUserData.password !== user.password
                                  ) {
                                    const updatePayload: any = { phone: loggedInUser.phone };
                                    if (editingUserData.name !== undefined && editingUserData.name !== user.name) {
                                      updatePayload.name = editingUserData.name;
                                    }
                                    if (editingUserData.email !== undefined && editingUserData.email !== user.email) {
                                      updatePayload.email = editingUserData.email;
                                    }
                                    if (editingUserData.phone !== undefined && editingUserData.phone !== user.phone) {
                                      updatePayload.phone = editingUserData.phone;
                                    }
                                    if (editingUserData.password !== undefined && editingUserData.password !== user.password) {
                                      updatePayload.password = editingUserData.password;
                                    }

                                    const detailsResponse = await fetch(`${apiUrl}/api/admin/users/${user.id}/details`, {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify(updatePayload)
                                    });

                                    const detailsData = await detailsResponse.json();

                                    if (!detailsData.success) {
                                      alert(`Error: ${detailsData.error || 'Failed to update user details'}`);
                                      return;
                                    }
                                  }

                                  // If balance is being edited, call the backend API
                                  if (editingUserData.accountBalance !== undefined && editingUserData.accountBalance !== user.accountBalance) {
                                    const response = await fetch(`${apiUrl}/api/admin/users/${user.id}/balance`, {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        phone: loggedInUser.phone,
                                        balance: editingUserData.accountBalance,
                                        reason: 'Admin adjustment'
                                      })
                                    });

                                    const data = await response.json();

                                    if (!data.success) {
                                      alert(`Error: ${data.error || 'Failed to update balance'}`);
                                      return;
                                    }
                                  }

                                  // Update local state
                                  updateUser(user.id, editingUserData);
                                  // If the logged-in user's data was updated, sync it to BetContext and UserContext
                                  if (user.id === loggedInUser.id) {
                                    if (editingUserData.accountBalance !== undefined) {
                                      syncBalance(editingUserData.accountBalance);
                                    }
                                    // Sync all edited fields to UserContext
                                    updateCurrentUser(editingUserData);
                                  }
                                  setEditingUserId(null);
                                  setEditingUserData({});
                                  alert('✅ User data updated successfully!');
                                } catch (error) {
                                  console.error('Error saving user data:', error);
                                  alert('Failed to save user data');
                                }
                              }}
                            >
                              <Save className="mr-1 h-3 w-3" /> Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingUserId(null);
                                setEditingUserData({});
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="font-medium text-foreground">{user.name}</h4>
                            <Badge variant="outline" className="text-[10px]">{user.username}</Badge>
                          </div>
                          <div className="grid gap-2 text-xs text-muted-foreground">
                            <p><strong>User ID:</strong> <span className="font-mono font-bold text-primary">{user.betnexaId || 'N/A'}</span></p>
                            <p><strong>Email:</strong> {user.email}</p>
                            <p><strong>Phone:</strong> {user.phone}</p>
                            <p><strong>Member Since:</strong> {user.createdAt ? formatDateInEAT(user.createdAt) : user.joinDate || 'N/A'}</p>
                            <p><strong>Password:</strong> <span className="font-mono font-bold text-primary">{user.password}</span></p>
                            {user.isBanned && (
                              <p><Badge className="bg-red-500/20 text-red-500 flex items-center gap-1 w-fit"><Ban className="h-3 w-3" /> BANNED</Badge></p>
                            )}
                            <p><strong>Balance:</strong> <span className="text-primary">KSH {user.accountBalance.toLocaleString()}</span></p>
                            <p><strong>Total Bets:</strong> {user.totalBets} | <strong>Winnings:</strong> KSH {user.totalWinnings.toLocaleString()}</p>
                            <p><strong>Verified:</strong> <Badge className={user.verified ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500"}>{user.verified ? "Yes" : "No"}</Badge></p>
                            <p className="flex items-center gap-2">
                              <strong>Withdrawal:</strong> 
                              {user.withdrawalActivated ? (
                                <Badge className="bg-green-500/20 text-green-500 flex items-center gap-1">
                                  <Unlock className="h-3 w-3" /> Activated
                                </Badge>
                              ) : (
                                <Badge className="bg-yellow-500/20 text-yellow-500 flex items-center gap-1">
                                  <Lock className="h-3 w-3" /> Not Activated
                                </Badge>
                              )}
                            </p>
                          </div>
                          <div className="mt-3 flex gap-2 flex-wrap">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingUserId(user.id);
                                setEditingUserData(user);
                              }}
                            >
                              <Edit2 className="mr-1 h-3 w-3" /> Edit User
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={userTransactionsLoading && selectedTransactionUser?.id === user.id}
                              onClick={() => fetchUserTransactions(user.id, user)}
                            >
                              <DollarSign className="mr-1 h-3 w-3" /> View Transactions
                            </Button>
                            <Button
                              size="sm"
                              className="bg-green-600 text-white hover:bg-green-700"
                              onClick={() => openManualTransactionDialog(user)}
                            >
                              <Plus className="mr-1 h-3 w-3" /> Insert Transaction
                            </Button>
                            {!user.withdrawalActivated ? (
                              <Button
                                size="sm"
                                variant="hero"
                                disabled={activatingUserId === user.id}
                                onClick={() => handleAdminActivateWithdrawal(user.id, user.name)}
                              >
                                {activatingUserId === user.id ? (
                                  <>
                                    <Clock className="mr-1 h-3 w-3 animate-spin" /> Activating...
                                  </>
                                ) : (
                                  <>
                                    <Unlock className="mr-1 h-3 w-3" /> Activate Withdrawal
                                  </>
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={activatingUserId === user.id}
                                onClick={() => {
                                  if (window.confirm(`Are you sure you want to deactivate withdrawal for ${user.name}?`)) {
                                    handleAdminDeactivateWithdrawal(user.id, user.name);
                                  }
                                }}
                              >
                                {activatingUserId === user.id ? (
                                  <>
                                    <Clock className="mr-1 h-3 w-3 animate-spin" /> Deactivating...
                                  </>
                                ) : (
                                  <>
                                    <Lock className="mr-1 h-3 w-3" /> Deactivate Withdrawal
                                  </>
                                )}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant={user.isBanned ? "hero" : "destructive"}
                              onClick={async () => {
                                const action = user.isBanned ? 'unban' : 'ban';
                                if (!window.confirm(`Are you sure you want to ${action} ${user.name}?`)) return;
                                try {
                                  const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
                                  const res = await fetch(`${apiUrl}/api/admin/users/${user.id}/ban`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ banned: !user.isBanned, phone: loggedInUser?.phone }),
                                  });
                                  const data = await res.json();
                                  if (data.success) {
                                    updateUser(user.id, { isBanned: !user.isBanned });
                                    alert(`${user.name} has been ${action}ned successfully.${!user.isBanned ? ' All their sessions have been terminated.' : ''}`);
                                  } else {
                                    alert(`Failed to ${action} user: ${data.error}`);
                                  }
                                } catch (e: any) {
                                  alert(`Error: ${e.message}`);
                                }
                              }}
                            >
                              <Ban className="mr-1 h-3 w-3" /> {user.isBanned ? 'Unban User' : 'Ban User'}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => {
                                if (window.confirm(`Are you sure you want to permanently delete ${user.name}'s account? This cannot be undone.`)) {
                                  handleDeleteUser(user.id, user.name);
                                }
                              }}
                            >
                              <Trash2 className="mr-1 h-3 w-3" /> Delete User
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </TabsContent>

          <Dialog open={showManualTransactionDialog} onOpenChange={setShowManualTransactionDialog}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Insert Manual Transaction</DialogTitle>
                <DialogDescription>
                  Add a deposit or withdrawal for {manualTransactionUser?.name || 'this user'}.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
                    <select
                      value={manualTransactionForm.type}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, type: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-0"
                    >
                      <option value="deposit">Deposit</option>
                      <option value="withdrawal">Withdrawal</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
                    <select
                      value={manualTransactionForm.status}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, status: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-0"
                    >
                      <option value="completed">Completed</option>
                      <option value="failed">Failed</option>
                      <option value="pending">Pending</option>
                    </select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Amount (KSH)</label>
                    <Input
                      type="number"
                      min="1"
                      step="0.01"
                      value={manualTransactionForm.amount}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, amount: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Method</label>
                    <Input
                      value={manualTransactionForm.method}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, method: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Date</label>
                    <Input
                      type="date"
                      value={manualTransactionForm.date}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, date: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Time</label>
                    <Input
                      type="time"
                      value={manualTransactionForm.time}
                      onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, time: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Phone Number</label>
                  <Input
                    value={manualTransactionForm.phoneNumber}
                    onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, phoneNumber: e.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
                  <Input
                    value={manualTransactionForm.description}
                    onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, description: e.target.value })}
                    placeholder="Manual deposit adjustment"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes</label>
                  <Input
                    value={manualTransactionForm.notes}
                    onChange={(e) => setManualTransactionForm({ ...manualTransactionForm, notes: e.target.value })}
                    placeholder="Optional admin note"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setShowManualTransactionDialog(false)}>
                    Cancel
                  </Button>
                  <Button className="bg-green-600 text-white hover:bg-green-700" onClick={handleManualTransactionSubmit}>
                    Save Transaction
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <TabsContent value="broadcast" className="space-y-6">
            <div className="mb-4">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">SMS Broadcast</h3>
              <p className="mt-1 text-xs text-muted-foreground">Send one message to all users or to a filtered audience.</p>
            </div>

            <Card className="border-border bg-card p-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Search (name, username, phone)</label>
                  <Input
                    className="mt-1"
                    value={broadcastFilters.searchTerm}
                    onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, searchTerm: e.target.value }))}
                    placeholder="e.g. denis or 2547..."
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">Activation Status</label>
                  <select
                    className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={broadcastFilters.activationStatus}
                    onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, activationStatus: e.target.value }))}
                  >
                    <option value="all">All</option>
                    <option value="activated">Activated Only</option>
                    <option value="not_activated">Not Activated Only</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">Betting Activity</label>
                  <select
                    className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={broadcastFilters.bettingStatus}
                    onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, bettingStatus: e.target.value }))}
                  >
                    <option value="all">All</option>
                    <option value="with_bets">Users With Bets</option>
                    <option value="no_bets">Users Without Bets</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">Minimum Account Balance (KSH)</label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0"
                    value={broadcastFilters.minBalance}
                    onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, minBalance: e.target.value }))}
                    placeholder="Leave empty for any"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">Minimum Total Winnings (KSH)</label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0"
                    value={broadcastFilters.minTotalWinnings}
                    onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, minTotalWinnings: e.target.value }))}
                    placeholder="Leave empty for any"
                  />
                </div>

                <div className="flex items-end">
                  <label className="inline-flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={broadcastFilters.includeAdmins}
                      onChange={(e) => setBroadcastFilters((prev) => ({ ...prev, includeAdmins: e.target.checked }))}
                    />
                    Include admin accounts
                  </label>
                </div>
              </div>

              <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
                <p className="font-medium text-foreground">Recipients Preview: {previewBroadcastRecipients.length}</p>
                <p className="text-xs text-muted-foreground mt-1">The message will be sent only to users matching the current filters.</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Broadcast Message</label>
                <textarea
                  className="mt-1 min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  maxLength={480}
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  placeholder="Type the SMS to send..."
                />
                <p className="mt-1 text-xs text-muted-foreground">{broadcastMessage.length}/480 characters</p>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="hero" disabled={sendingBroadcast || previewBroadcastRecipients.length === 0} onClick={handleSendBroadcast}>
                  {sendingBroadcast ? (
                    <><Clock className="mr-2 h-4 w-4 animate-spin" /> Sending...</>
                  ) : (
                    <><Megaphone className="mr-2 h-4 w-4" /> Send Broadcast SMS</>
                  )}
                </Button>
                {previewBroadcastRecipients.length === 0 && (
                  <span className="text-xs text-red-500">No recipients match current filters</span>
                )}
              </div>

              {broadcastResult && (
                <div className="rounded-md border border-border bg-background p-3 text-sm">
                  <p className="font-medium text-foreground">{broadcastResult.message || 'Broadcast finished'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Matched: {broadcastResult.matchedRecipients || 0} | Sent: {broadcastResult.sent || 0} | Failed: {broadcastResult.failed || 0}
                  </p>
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="earnings" className="space-y-6">
            <EarningsCalculator />
          </TabsContent>

          <TabsContent value="transactions" className="space-y-6">
            <Card className="border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground">Search Transactions</label>
                  <Input
                    value={transactionSearchQuery}
                    onChange={(e) => setTransactionSearchQuery(e.target.value)}
                    placeholder="Search by username or phone number"
                    className="mt-2"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-6 shrink-0"
                  onClick={fetchAllTransactions}
                  disabled={loadingPayments}
                >
                  {loadingPayments ? '...' : '↻ Refresh'}
                </Button>
              </div>
            </Card>

            {/* --- DEPOSITS SECTION --- */}
            {(() => {
              const deposits = filteredTransactions.filter((t: any) => t.type === 'deposit');
              const resolved = deposits.filter((t: any) => t.status === 'completed' || t.status === 'failed');
              const completed = resolved.filter((t: any) => t.status === 'completed');
              const failed = resolved.filter((t: any) => t.status === 'failed');
              const successRate = resolved.length > 0 ? Math.round((completed.length / resolved.length) * 100) : 0;
              const failRate = resolved.length > 0 ? 100 - successRate : 0;

              return (
                <>
                  <div className="mb-2">
                    <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">Deposits</h3>
                    {resolved.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden flex">
                            <div className="h-full transition-all bg-green-500" style={{ width: `${successRate}%` }} />
                            <div className="h-full transition-all bg-red-500" style={{ width: `${failRate}%` }} />
                          </div>
                        </div>
                        <div className="flex justify-between text-xs font-medium">
                          <span className="text-green-500">{successRate}% Success ({completed.length})</span>
                          <span className="text-red-500">{failRate}% Failed ({failed.length})</span>
                          <span className="text-muted-foreground">{deposits.length - resolved.length} Pending</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    {deposits.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        {transactionQuery ? 'No deposits found for this search' : 'No deposits found'}
                      </p>
                    )}
                    {deposits.map((transaction: any) => (
                      <Card key={transaction.id} className="border-border bg-card p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-1">
                            <div className="rounded-full p-2 bg-green-500/20">
                              <ArrowDown className="h-4 w-4 text-green-500" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">
                                {getTransactionAccountLabel(transaction)} - Deposit
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {formatTransactionDateInEAT(transaction.created_at)} via {transaction.method || 'M-Pesa'}{transaction.phone_number ? ` • ${transaction.phone_number}` : ''}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-sm text-green-500">
                              +KSH {Number(transaction.amount).toLocaleString()}
                            </p>
                            <div className="flex items-center justify-end gap-2 mt-1">
                              {transaction.status === "completed" && (
                                <>
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                  <span className="text-xs text-green-500">Completed</span>
                                  <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-yellow-500 hover:text-yellow-600"
                                    onClick={async () => { try { await updateTransactionStatus(transaction.id, "pending", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'pending' } : t)); } catch (e) { console.error('Failed to revert:', e); } }}>
                                    Revert
                                  </Button>
                                </>
                              )}
                              {transaction.status === "pending" && (
                                <>
                                  <Clock className="h-4 w-4 text-yellow-500" />
                                  <span className="text-xs text-yellow-500">Pending</span>
                                  <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-green-500 hover:text-green-600"
                                    onClick={async () => { try { await updateTransactionStatus(transaction.id, "completed", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'completed' } : t)); } catch (e) { console.error('Failed to approve:', e); } }}>
                                    Approve
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-xs h-6 text-red-500 hover:text-red-600"
                                    onClick={async () => { try { await updateTransactionStatus(transaction.id, "failed", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'failed' } : t)); } catch (e) { console.error('Failed to reject:', e); } }}>
                                    Reject
                                  </Button>
                                </>
                              )}
                              {transaction.status === "failed" && (
                                <>
                                  <XCircle className="h-4 w-4 text-red-500" />
                                  <span className="text-xs text-red-500">Failed</span>
                                  <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-yellow-500 hover:text-yellow-600"
                                    onClick={async () => { try { await updateTransactionStatus(transaction.id, "pending", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'pending' } : t)); } catch (e) { console.error('Failed to revert:', e); } }}>
                                    Revert
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </>
              );
            })()}

            {/* Activation Fees section removed per request. Activation and priority fee entries remain visible in Deposits. */}

            {/* --- WITHDRAWALS SECTION --- */}
            <div className="mt-8 mb-2">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">Withdrawals</h3>
            </div>
            <div className="space-y-3">
              {filteredTransactions.filter((t: any) => t.type !== 'deposit').length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {transactionQuery ? 'No withdrawals found for this search' : 'No withdrawals found'}
                </p>
              )}
              {filteredTransactions.filter((t: any) => t.type !== 'deposit').map((transaction: any) => (
                <Card key={transaction.id} className="border-border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div className="rounded-full p-2 bg-blue-500/20">
                        <ArrowUp className="h-4 w-4 text-blue-500" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">
                          {getTransactionAccountLabel(transaction)} - {transaction.type === "withdrawal" ? "Withdrawal" : transaction.type}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatTransactionDateInEAT(transaction.created_at)} via {transaction.method || 'M-Pesa'}{transaction.phone_number ? ` • ${transaction.phone_number}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-sm text-blue-500">
                        -KSH {Number(transaction.amount).toLocaleString()}
                      </p>
                      <div className="flex items-center justify-end gap-2 mt-1">
                        {transaction.status === "completed" && (
                          <>
                            <CheckCircle className="h-4 w-4 text-green-500" />
                            <span className="text-xs text-green-500">Completed</span>
                            <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-yellow-500 hover:text-yellow-600"
                              onClick={async () => { try { await updateTransactionStatus(transaction.id, "pending", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'pending' } : t)); } catch (e) { console.error('Failed to revert:', e); } }}>
                              Revert
                            </Button>
                          </>
                        )}
                        {transaction.status === "pending" && (
                          <>
                            <Clock className="h-4 w-4 text-yellow-500" />
                            <span className="text-xs text-yellow-500">Pending</span>
                            <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-green-500 hover:text-green-600"
                              onClick={async () => { try { await updateTransactionStatus(transaction.id, "completed", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'completed' } : t)); } catch (e) { console.error('Failed to approve:', e); } }}>
                              Approve
                            </Button>
                            <Button size="sm" variant="ghost" className="text-xs h-6 text-red-500 hover:text-red-600"
                              onClick={async () => { try { await updateTransactionStatus(transaction.id, "failed", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'failed' } : t)); } catch (e) { console.error('Failed to reject:', e); } }}>
                              Reject
                            </Button>
                          </>
                        )}
                        {transaction.status === "failed" && (
                          <>
                            <XCircle className="h-4 w-4 text-red-500" />
                            <span className="text-xs text-red-500">Failed</span>
                            <Button size="sm" variant="ghost" className="ml-2 text-xs h-6 text-yellow-500 hover:text-yellow-600"
                              onClick={async () => { try { await updateTransactionStatus(transaction.id, "pending", loggedInUser?.phone); setAllTransactions(prev => prev.map(t => t.id === transaction.id ? { ...t, status: 'pending' } : t)); } catch (e) { console.error('Failed to revert:', e); } }}>
                              Revert
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            {/* Revenue Today Card */}
            <Card className="mt-8 border-gold/30 bg-card p-6 neon-border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Revenue Today</p>
                  <p className="mt-4 text-3xl font-bold text-gold">KSH {todayRevenue.toLocaleString()}</p>
                </div>
                <div className="text-6xl text-gold/30">💰</div>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="bets" className="space-y-6">
            <div className="mb-4">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">Manage Bets</h3>
              <p className="mt-1 text-xs text-muted-foreground">All open, won, and lost bets - Mark selections individually for multibets</p>
            </div>

            {markedBets.size > 0 && (
              <div className="mb-4 flex justify-end gap-3 rounded-xl border border-violet-500/40 bg-violet-500/10 p-3 shadow-lg shadow-violet-500/10">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={moveMarkedBets}
                  className="text-xs bg-violet-600 text-white hover:bg-violet-700 shadow-md"
                >
                  <ArrowRightLeft className="mr-1 h-3 w-3" /> Move {markedBets.size} Marked
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={deleteMarkedBets}
                  disabled={deletingMarkedBets}
                  className="text-xs shadow-md"
                >
                  <Trash2 className="mr-1 h-3 w-3" /> Delete {markedBets.size} Marked
                </Button>
              </div>
            )}
            
            {bets.length === 0 ? (
              <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-muted-foreground">
                No bets found
              </div>
            ) : (
              <div className="space-y-8">
                {/* Separate and sort bets */}
                {(() => {
                  // Separate and sort bets while excluding admin-moved bets from active counts.
                  const activeBets = bets.filter(b => !movedBetIds.has(b.id));
                  const openBets = activeBets.filter(b => b.status === "Open").sort((a, b) => {
                    const dateA = new Date(a.date).getTime();
                    const dateB = new Date(b.date).getTime();
                    return dateB - dateA; // Latest first
                  });
                  
                  const settledBets = activeBets.filter(b => b.status !== "Open");
                  const wonBets = settledBets.filter(b => b.status === "Won");
                  const lostBets = settledBets.filter(b => b.status === "Lost");
                  const movedBets = bets.filter(b => movedBetIds.has(b.id));
                  
                  // Render Open Bets Section
                  return (
                    <div className="space-y-0">
                      {/* OPEN BETS - At Top */}
                      {openBets.length > 0 && (
                        <div className="space-y-3 pb-8 border-b-2 border-yellow-500/30">
                          <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm py-2 flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-yellow-500 flex items-center gap-2">
                              <Clock className="h-4 w-4" /> Open Bets ({openBets.length})
                            </h4>
                            {markedBets.size > 0 && (
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={moveMarkedBets}
                                  className="text-xs bg-violet-600 text-white hover:bg-violet-700 shadow-md"
                                >
                                  <ArrowRightLeft className="mr-1 h-3 w-3" /> Move {markedBets.size} Marked
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={deleteMarkedBets}
                                  disabled={deletingMarkedBets}
                                  className="text-xs shadow-md"
                                >
                                  <Trash2 className="mr-1 h-3 w-3" /> Delete {markedBets.size} Marked
                                </Button>
                              </div>
                            )}
                          </div>
                          
                          {/* Open Bets Table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-secondary/50 border-b border-border">
                                <tr className="text-muted-foreground">
                                  <th className="text-center p-2 font-semibold w-8">
                                    <input
                                      type="checkbox"
                                      checked={openBets.length > 0 && openBets.every(b => markedBets.has(b.id))}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setMarkedBets(new Set([...markedBets, ...openBets.map(b => b.id)]));
                                        } else {
                                          const newSet = new Set(markedBets);
                                          openBets.forEach(b => newSet.delete(b.id));
                                          setMarkedBets(newSet);
                                        }
                                      }}
                                      className="cursor-pointer"
                                    />
                                  </th>
                                  <th className="text-left p-2 font-semibold">Username</th>
                                  <th className="text-left p-2 font-semibold">Phone</th>
                                  <th className="text-center p-2 font-semibold">Action</th>
                                  <th className="text-center p-2 font-semibold">Status</th>
                                  <th className="text-right p-2 font-semibold">Stake (KSH)</th>
                                  <th className="text-right p-2 font-semibold">Win Amount (KSH)</th>
                                  <th className="text-left p-2 font-semibold">Bet ID</th>
                                  <th className="text-left p-2 font-semibold">Date & Time Placed</th>
                                  <th className="text-center p-2 font-semibold">Odds</th>
                                  <th className="text-center p-2 font-semibold">Selections</th>
                                  <th className="text-center p-2 font-semibold">View</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {openBets.map((bet) => {
                                  const betOutcomes = selectionOutcomes[bet.id];
                                  return (
                                    <tr key={bet.id} className="hover:bg-secondary/30 transition-colors">
                                      <td className="p-2 text-center w-8">
                                        <input
                                          type="checkbox"
                                          checked={markedBets.has(bet.id)}
                                          onChange={() => toggleBetMark(bet.id)}
                                          className="cursor-pointer"
                                        />
                                      </td>
                                      <td className="p-2 text-foreground font-medium">{bet.username || 'Unknown'}</td>
                                      <td className="p-2 text-muted-foreground">{bet.phone_number || '-'}</td>
                                      <td className="p-2 text-center">
                                        <button
                                          onClick={() => sendBetDetailsSms(bet)}
                                          disabled={sendingBetSmsId === bet.id || !!smsTriggeredBets[bet.id]}
                                          className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                                            smsTriggeredBets[bet.id]
                                              ? 'bg-slate-500 text-white cursor-not-allowed'
                                              : sendingBetSmsId === bet.id
                                              ? 'bg-blue-500/50 text-blue-100 cursor-wait'
                                              : 'bg-blue-600 text-white hover:bg-blue-700'
                                          }`}
                                        >
                                          {smsTriggeredBets[bet.id] ? 'Already Sent' : sendingBetSmsId === bet.id ? 'Sending...' : 'Send SMS'}
                                        </button>
                                      </td>
                                      <td className="p-2 text-center">
                                        <Badge variant="secondary" className="text-[10px]">{bet.status}</Badge>
                                      </td>
                                      <td className="p-2 text-right text-primary font-semibold">{bet.stake.toLocaleString()}</td>
                                      <td className="p-2 text-right text-primary font-semibold">{bet.potentialWin.toLocaleString()}</td>
                                      <td className="p-2 text-foreground font-mono">#{bet.betId}</td>
                                      <td className="p-2 text-muted-foreground whitespace-nowrap">
                                        {bet.date ? formatTransactionDateInEAT(bet.date) : 'Unknown'}
                                      </td>
                                      <td className="p-2 text-center">{bet.totalOdds.toFixed(2)}</td>
                                      <td className="p-2 text-center">{bet.selections.length}</td>
                                      <td className="p-2 text-center">
                                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => openBetDetails(bet)}>
                                          View
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          
                        </div>
                      )}
                      
                      {/* WON BETS - Below Open with Divider */}
                      {wonBets.length > 0 && (
                        <div className="space-y-3 pt-8 pb-8 border-b-2 border-green-500/30">
                          <div className="bg-card/95 backdrop-blur-sm py-2 flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-green-500 flex items-center gap-2">
                              <CheckCircle className="h-4 w-4" /> Won Bets ({wonBets.length})
                            </h4>
                            {markedBets.size > 0 && (
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={moveMarkedBets}
                                  className="text-xs bg-violet-600 text-white hover:bg-violet-700 shadow-md"
                                >
                                  <ArrowRightLeft className="mr-1 h-3 w-3" /> Move {markedBets.size} Marked
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={deleteMarkedBets}
                                  disabled={deletingMarkedBets}
                                  className="text-xs shadow-md"
                                >
                                  <Trash2 className="mr-1 h-3 w-3" /> Delete {markedBets.size} Marked
                                </Button>
                              </div>
                            )}
                          </div>
                          
                          {/* Won Bets Table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-green-500/10 border-b border-green-500/30">
                                <tr className="text-green-500">
                                  <th className="text-center p-2 font-semibold w-8">
                                    <input
                                      type="checkbox"
                                      checked={wonBets.length > 0 && wonBets.every(b => markedBets.has(b.id))}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setMarkedBets(new Set([...markedBets, ...wonBets.map(b => b.id)]));
                                        } else {
                                          const newSet = new Set(markedBets);
                                          wonBets.forEach(b => newSet.delete(b.id));
                                          setMarkedBets(newSet);
                                        }
                                      }}
                                      className="cursor-pointer"
                                    />
                                  </th>
                                  <th className="text-left p-2 font-semibold">Username</th>
                                  <th className="text-left p-2 font-semibold">Phone</th>
                                  <th className="text-center p-2 font-semibold">Action</th>
                                  <th className="text-center p-2 font-semibold">Status</th>
                                  <th className="text-right p-2 font-semibold">Stake (KSH)</th>
                                  <th className="text-right p-2 font-semibold">Win Amount (KSH)</th>
                                  <th className="text-left p-2 font-semibold">Bet ID</th>
                                  <th className="text-left p-2 font-semibold">Date & Time Placed</th>
                                  <th className="text-center p-2 font-semibold">Odds</th>
                                  <th className="text-center p-2 font-semibold">Selections</th>
                                  <th className="text-center p-2 font-semibold">View</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {wonBets.map((bet) => {
                                  return (
                                    <tr key={bet.id} className="bg-green-500/5 hover:bg-green-500/10 transition-colors">
                                      <td className="p-2 text-center w-8">
                                        <input
                                          type="checkbox"
                                          checked={markedBets.has(bet.id)}
                                          onChange={() => toggleBetMark(bet.id)}
                                          className="cursor-pointer"
                                        />
                                      </td>
                                      <td className="p-2 text-foreground font-medium">{bet.username || 'Unknown'}</td>
                                      <td className="p-2 text-muted-foreground">{bet.phone_number || '-'}</td>
                                      <td className="p-2 text-center">
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 text-[10px]"
                                          onClick={() => sendBetDetailsSms(bet)}
                                          disabled={sendingBetSmsId === bet.id || !!smsTriggeredBets[bet.id]}
                                        >
                                          {smsTriggeredBets[bet.id] ? (
                                            <CheckCircle className="h-3 w-3" />
                                          ) : sendingBetSmsId === bet.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Megaphone className="h-3 w-3" />
                                          )}
                                        </Button>
                                      </td>
                                      <td className="p-2 text-center">
                                        <Badge className="bg-green-500/15 text-green-500 hover:bg-green-500/15 text-[10px]">{bet.status}</Badge>
                                      </td>
                                      <td className="p-2 text-right text-primary font-semibold">{bet.stake.toLocaleString()}</td>
                                      <td className="p-2 text-right text-green-500 font-bold">{bet.potentialWin.toLocaleString()}</td>
                                      <td className="p-2 text-foreground font-mono">#{bet.betId}</td>
                                      <td className="p-2 text-muted-foreground whitespace-nowrap">
                                        {bet.date ? formatTransactionDateInEAT(bet.date) : 'Unknown'}
                                      </td>
                                      <td className="p-2 text-center">{bet.totalOdds.toFixed(2)}</td>
                                      <td className="p-2 text-center">{bet.selections.length}</td>
                                      <td className="p-2 text-center">
                                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => openBetDetails(bet)}>
                                          View
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      
                      {/* MOVED BETS - Below Won Bets / Admin-only archive */}
                      {movedBets.length > 0 && (
                        <div className="space-y-3 pt-8 pb-8 border-b-2 border-violet-500/30">
                          <div className="bg-card/95 backdrop-blur-sm py-2 flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-violet-500 flex items-center gap-2">
                              <ArrowRightLeft className="h-4 w-4" /> Moved Bets ({movedBets.length})
                            </h4>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-violet-500/10 border-b border-violet-500/30">
                                <tr className="text-violet-500">
                                  <th className="text-left p-2 font-semibold">Username</th>
                                  <th className="text-left p-2 font-semibold">Phone</th>
                                  <th className="text-center p-2 font-semibold">Status</th>
                                  <th className="text-right p-2 font-semibold">Stake (KSH)</th>
                                  <th className="text-right p-2 font-semibold">Win Amount (KSH)</th>
                                  <th className="text-left p-2 font-semibold">Bet ID</th>
                                  <th className="text-left p-2 font-semibold">Date & Time Placed</th>
                                  <th className="text-center p-2 font-semibold">Odds</th>
                                  <th className="text-center p-2 font-semibold">Selections</th>
                                  <th className="text-center p-2 font-semibold">View</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {movedBets.map((bet) => (
                                  <tr key={bet.id} className="bg-violet-500/5 hover:bg-violet-500/10 transition-colors">
                                    <td className="p-2 text-foreground font-medium">{bet.username || 'Unknown'}</td>
                                    <td className="p-2 text-muted-foreground">{bet.phone_number || '-'}</td>
                                    <td className="p-2 text-center">
                                      <Badge className="bg-violet-500/15 text-violet-400 hover:bg-violet-500/15 text-[10px]">Moved</Badge>
                                    </td>
                                    <td className="p-2 text-right text-primary font-semibold">{bet.stake.toLocaleString()}</td>
                                    <td className="p-2 text-right text-violet-500 font-bold">{bet.potentialWin.toLocaleString()}</td>
                                    <td className="p-2 text-foreground font-mono">#{bet.betId}</td>
                                    <td className="p-2 text-muted-foreground whitespace-nowrap">
                                      {bet.date ? formatTransactionDateInEAT(bet.date) : 'Unknown'}
                                    </td>
                                    <td className="p-2 text-center">{bet.totalOdds.toFixed(2)}</td>
                                    <td className="p-2 text-center">{bet.selections.length}</td>
                                    <td className="p-2 text-center">
                                      <div className="flex items-center justify-center gap-2">
                                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => openBetDetails(bet)}>
                                          View
                                        </Button>
                                        <Button
                                          variant="secondary"
                                          size="sm"
                                          className="h-7 text-[10px] bg-violet-600 text-white hover:bg-violet-700"
                                          onClick={() => undoMovedBet(bet.id)}
                                        >
                                          Undo
                                        </Button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      
                      {/* LOST BETS - Below Won with Divider */}
                      {lostBets.length > 0 && (
                        <div className="space-y-3 pt-8">
                          <div className="bg-card/95 backdrop-blur-sm py-2 flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-red-500 flex items-center gap-2">
                              <XCircle className="h-4 w-4" /> Lost Bets ({lostBets.length})
                            </h4>
                            {markedBets.size > 0 && (
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={moveMarkedBets}
                                  className="text-xs bg-violet-600 text-white hover:bg-violet-700 shadow-md"
                                >
                                  <ArrowRightLeft className="mr-1 h-3 w-3" /> Move {markedBets.size} Marked
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={deleteMarkedBets}
                                  disabled={deletingMarkedBets}
                                  className="text-xs shadow-md"
                                >
                                  <Trash2 className="mr-1 h-3 w-3" /> Delete {markedBets.size} Marked
                                </Button>
                              </div>
                            )}
                          </div>
                          
                          {/* Lost Bets Table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-red-500/10 border-b border-red-500/30">
                                <tr className="text-red-500">
                                  <th className="text-center p-2 font-semibold w-8">
                                    <input
                                      type="checkbox"
                                      checked={lostBets.length > 0 && lostBets.every(b => markedBets.has(b.id))}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setMarkedBets(new Set([...markedBets, ...lostBets.map(b => b.id)]));
                                        } else {
                                          const newSet = new Set(markedBets);
                                          lostBets.forEach(b => newSet.delete(b.id));
                                          setMarkedBets(newSet);
                                        }
                                      }}
                                      className="cursor-pointer"
                                    />
                                  </th>
                                  <th className="text-left p-2 font-semibold">Username</th>
                                  <th className="text-left p-2 font-semibold">Phone</th>
                                  <th className="text-center p-2 font-semibold">Action</th>
                                  <th className="text-center p-2 font-semibold">Status</th>
                                  <th className="text-right p-2 font-semibold">Stake (KSH)</th>
                                  <th className="text-right p-2 font-semibold">Win Amount (KSH)</th>
                                  <th className="text-left p-2 font-semibold">Bet ID</th>
                                  <th className="text-left p-2 font-semibold">Date & Time Placed</th>
                                  <th className="text-center p-2 font-semibold">Odds</th>
                                  <th className="text-center p-2 font-semibold">Selections</th>
                                  <th className="text-center p-2 font-semibold">View</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {lostBets.map((bet) => {
                                  return (
                                    <tr key={bet.id} className="bg-red-500/5 hover:bg-red-500/10 transition-colors">
                                      <td className="p-2 text-center w-8">
                                        <input
                                          type="checkbox"
                                          checked={markedBets.has(bet.id)}
                                          onChange={() => toggleBetMark(bet.id)}
                                          className="cursor-pointer"
                                        />
                                      </td>
                                      <td className="p-2 text-foreground font-medium">{bet.username || 'Unknown'}</td>
                                      <td className="p-2 text-muted-foreground">{bet.phone_number || '-'}</td>
                                      <td className="p-2 text-center">
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 text-[10px]"
                                          onClick={() => sendBetDetailsSms(bet)}
                                          disabled={sendingBetSmsId === bet.id || !!smsTriggeredBets[bet.id]}
                                        >
                                          {smsTriggeredBets[bet.id] ? (
                                            <CheckCircle className="h-3 w-3" />
                                          ) : sendingBetSmsId === bet.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Megaphone className="h-3 w-3" />
                                          )}
                                        </Button>
                                      </td>
                                      <td className="p-2 text-center">
                                        <Badge variant="destructive" className="text-[10px]">{bet.status}</Badge>
                                      </td>
                                      <td className="p-2 text-right text-primary font-semibold">{bet.stake.toLocaleString()}</td>
                                      <td className="p-2 text-right text-red-500 font-bold">0</td>
                                      <td className="p-2 text-foreground font-mono">#{bet.betId}</td>
                                      <td className="p-2 text-muted-foreground whitespace-nowrap">
                                        {bet.date ? formatTransactionDateInEAT(bet.date) : 'Unknown'}
                                      </td>
                                      <td className="p-2 text-center">{bet.totalOdds.toFixed(2)}</td>
                                      <td className="p-2 text-center">{bet.selections.length}</td>
                                      <td className="p-2 text-center">
                                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => openBetDetails(bet)}>
                                          View
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </TabsContent>


        </Tabs>

        <Dialog open={showUserTransactionsDialog} onOpenChange={(open) => {
          if (!open) {
            setShowUserTransactionsDialog(false);
            setSelectedUserTransactions(null);
            setSelectedTransactionUser(null);
          }
        }}>
          <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-hidden rounded-[32px] border border-violet-500/15 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 shadow-[0_24px_80px_rgba(145,92,182,0.22)] ring-1 ring-violet-500/10">
            <DialogHeader className="bg-slate-900/90 border-b border-violet-500/10 px-6 py-5">
              <DialogTitle className="text-2xl font-semibold text-slate-50">
                {selectedTransactionUser ? `Transactions for ${selectedTransactionUser.name}` : 'User Transactions'}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-slate-300">
                Showing all deposits and withdrawals for this user. Use Approve, Reject or Revert to update transaction status.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4 overflow-y-auto max-h-[68vh] pr-3 pb-4">
              {selectedUserTransactions?.user && (
                <div className="grid grid-cols-1 gap-3 rounded-[28px] border border-violet-500/15 bg-gradient-to-r from-slate-900/95 via-violet-950/80 to-slate-950 p-4 shadow-inner shadow-violet-500/10 sm:grid-cols-2">
                  <div className="text-slate-200"><span className="text-slate-400">Name:</span> {selectedTransactionUser?.name || selectedUserTransactions.user?.username || 'N/A'}</div>
                  <div className="text-slate-200"><span className="text-slate-400">Phone:</span> {selectedUserTransactions.user?.phone_number || selectedTransactionUser?.phone || 'N/A'}</div>
                  <div className="text-slate-200"><span className="text-slate-400">User ID:</span> {selectedUserTransactions.user?.id || selectedTransactionUser?.id || 'N/A'}</div>
                  <div className="text-slate-200"><span className="text-slate-400">Balance:</span> KSH {selectedUserTransactions.user?.account_balance?.toLocaleString() ?? '0'}</div>
                </div>
              )}

              {selectedUserTransactions?.activation_fees && selectedUserTransactions.activation_fees.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-base font-semibold text-slate-200">Activation Fees</h4>
                  {selectedUserTransactions.activation_fees.map((fee: any) => (
                    <Card key={fee.id} className="bg-gradient-to-br from-orange-900 to-orange-800 border-orange-600 text-orange-50 p-4 rounded-xl">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">{fee.fee_type ? fee.fee_type.toUpperCase() : 'Activation Fee'}</p>
                          <p className="text-sm opacity-80">{formatTransactionDateInEAT(fee.created_at)}</p>
                          <p className="text-sm"><strong>Amount:</strong> KSH {Number(fee.amount || 0).toLocaleString()}</p>
                          <p className="text-sm"><strong>Status:</strong> <Badge className={fee.status === 'completed' ? 'bg-orange-500/20 text-orange-100' : fee.status === 'pending' ? 'bg-amber-400/20 text-amber-200' : 'bg-rose-500/20 text-rose-100'}>{(fee.status || '').charAt(0).toUpperCase() + (fee.status || '').slice(1)}</Badge></p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              <div className="rounded-[28px] border border-fuchsia-500/10 bg-gradient-to-br from-slate-900/95 via-slate-950/95 to-slate-900 p-4 shadow-xl shadow-fuchsia-500/10">
                {userTransactionsLoading ? (
                  <div className="text-center text-sm text-muted-foreground">Loading transactions...</div>
                ) : !selectedUserTransactions?.transactions || selectedUserTransactions.transactions.length === 0 ? (
                  <div className="text-center text-sm text-muted-foreground">No transactions found for this user.</div>
                ) : (
                  <div className="space-y-3">
                    {selectedUserTransactions.transactions.map((transaction: any) => {
                      const status = `${transaction.status || ''}`.toLowerCase();
                      const isPending = status === 'pending';
                      const isCompleted = status === 'completed';
                      const isFailed = status === 'failed' || status === 'cancelled';

                      // Determine visual category
                      const methodLower = (transaction.method || transaction.payment_method || '').toString().toLowerCase();
                      const txType = (transaction.type || '').toString().toLowerCase();

                      let cardClasses = 'border border-violet-500/10 p-4 rounded-xl';
                      let badgeGradient = isCompleted ? 'bg-gradient-to-r from-emerald-500/20 to-emerald-400/20 text-emerald-200' : isFailed ? 'bg-gradient-to-r from-rose-500/20 to-pink-400/20 text-rose-200' : 'bg-gradient-to-r from-amber-400/20 to-yellow-300/20 text-amber-200';

                      // Apply colors per category: withdrawal, priority fee, activation fee, normal deposit
                      if (txType === 'withdrawal') {
                        cardClasses = 'bg-gradient-to-br from-cyan-900 to-cyan-800 border-cyan-600 text-cyan-50 p-4 rounded-xl shadow-md';
                        badgeGradient = isCompleted ? 'bg-cyan-600/20 text-cyan-100' : isFailed ? 'bg-rose-600/20 text-rose-100' : 'bg-amber-400/20 text-amber-200';
                      } else if (methodLower.includes('priority')) {
                        cardClasses = 'bg-gradient-to-br from-purple-900 to-purple-800 border-purple-600 text-purple-50 p-4 rounded-xl shadow-md';
                        badgeGradient = isCompleted ? 'bg-purple-500/20 text-purple-100' : isFailed ? 'bg-rose-600/20 text-rose-100' : 'bg-amber-400/20 text-amber-200';
                      } else if (methodLower.includes('activation') || transaction.fee_type === 'activation') {
                        cardClasses = 'bg-gradient-to-br from-orange-900 to-orange-800 border-orange-600 text-orange-50 p-4 rounded-xl shadow-md';
                        badgeGradient = isCompleted ? 'bg-orange-500/20 text-orange-100' : isFailed ? 'bg-rose-600/20 text-rose-100' : 'bg-amber-400/20 text-amber-200';
                      } else if (txType === 'deposit') {
                        cardClasses = 'bg-gradient-to-br from-emerald-900 to-emerald-800 border-emerald-600 text-emerald-50 p-4 rounded-xl shadow-md';
                        badgeGradient = isCompleted ? 'bg-emerald-500/20 text-emerald-100' : isFailed ? 'bg-rose-600/20 text-rose-100' : 'bg-amber-400/20 text-amber-200';
                      }

                      return (
                        <Card key={transaction.id} className={cardClasses}>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-2">
                              <p className="font-semibold">{transaction.type?.toUpperCase() || 'Transaction'}</p>
                              <p className="text-sm opacity-80">{transaction.external_reference ? `Reference: ${transaction.external_reference}` : transaction.transaction_id ? `Reference: ${transaction.transaction_id}` : ''}</p>
                              <p className="text-sm opacity-70">{formatTransactionDateInEAT(transaction.created_at || transaction.date || transaction.createdAt)}</p>
                              <p className="text-sm"><strong>Amount:</strong> KSH {Number(transaction.amount || transaction.amount).toLocaleString()}</p>
                              <p className="text-sm"><strong>Method:</strong> {transaction.method || transaction.payment_method || 'Unknown'}</p>
                              <p className="text-sm"><strong>Status:</strong>{' '}
                                <Badge className={badgeGradient}>
                                  {status.charAt(0).toUpperCase() + status.slice(1)}
                                </Badge>
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isCompleted || transactionActionInProgress === transaction.id}
                                onClick={() => handleTransactionStatusChange(transaction.id, 'completed')}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={isFailed || transactionActionInProgress === transaction.id}
                                onClick={() => handleTransactionStatusChange(transaction.id, 'failed')}
                              >
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isPending || transactionActionInProgress === transaction.id}
                                onClick={() => handleTransactionStatusChange(transaction.id, 'pending')}
                              >
                                Revert
                              </Button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={showBetDetailsDialog} onOpenChange={(open) => { if (!open) closeBetDetails(); }}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Bet Details</DialogTitle>
              <DialogDescription>Full bet review including teams, market, pick, and odds.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 p-2">
              {selectedBetDetails ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-muted-foreground">User</p>
                      <p className="font-medium text-foreground">{selectedBetDetails.username || 'Unknown'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Phone</p>
                      <p className="font-medium text-foreground">{selectedBetDetails.phone_number || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Bet ID</p>
                      <p className="font-medium text-foreground">#{selectedBetDetails.betId}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Placed</p>
                      <p className="font-medium text-foreground">{selectedBetDetails.date ? formatTransactionDateInEAT(selectedBetDetails.date) : 'Unknown'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Status</p>
                      <p className="font-medium text-foreground">{selectedBetDetails.status}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Stake</p>
                      <p className="font-medium text-foreground">KSH {selectedBetDetails.stake.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Odds</p>
                      <p className="font-medium text-foreground">{selectedBetDetails.totalOdds.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Potential Win</p>
                      <p className="font-medium text-foreground">KSH {selectedBetDetails.potentialWin.toLocaleString()}</p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-foreground">Selections</h4>
                    <div className="space-y-3">
                      {selectedBetDetails.selections.map((selection, idx) => (
                        <Card key={idx} className="rounded-lg border-border bg-card p-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <p className="text-xs text-muted-foreground">Match</p>
                              <p className="font-medium text-foreground">{selection.match || selection.matchId || 'Unknown match'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Market</p>
                              <p className="font-medium text-foreground">{getSelectionMarketName(selection.market)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Pick</p>
                              <p className="font-medium text-foreground">{getSelectionPickLabel(selection.type)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Odds</p>
                              <p className="font-medium text-foreground">{typeof selection.odds === 'number' ? selection.odds.toFixed(2) : String(selection.odds || 'N/A')}</p>
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No bet selected.</p>
              )}
              <div className="flex justify-end">
                <Button variant="ghost" onClick={closeBetDetails}>Close</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Fetch Games Modal */}
        <FetchGamesFetchModal
          isOpen={showFetchGamesModal}
          onClose={() => setShowFetchGamesModal(false)}
          onExecute={async (games) => {
            try {
              const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
              
              // Step 1: Fetch existing games to check for duplicates
              let existingGameIds = new Set<string>();
              try {
                const existingRes = await fetch(`${apiUrl}/api/admin/games`);
                const existingData = await existingRes.json();
                if (existingData.success && existingData.games) {
                  for (const g of existingData.games) {
                    // Check game_id for af- prefix (API Football sourced)
                    if (g.game_id) existingGameIds.add(g.game_id);
                    // Also check by team names + date to catch manually added duplicates
                    const matchKey = `${g.home_team}|${g.away_team}|${(g.time || '').split('T')[0]}`.toLowerCase();
                    existingGameIds.add(matchKey);
                  }
                }
              } catch (e) {
                console.warn('Could not fetch existing games for dedup check:', e);
              }

              // Add each game using the standard admin API
              let successCount = 0;
              let failCount = 0;
              let skipCount = 0;
              
              for (const game of games) {
                try {
                  // Check for duplicates by api_fixture_id and team+date
                  const afGameId = `af-${game.api_fixture_id}`;
                  const matchKey = `${game.home_team}|${game.away_team}|${(game.time_utc || game.time_eat || '').split('T')[0]}`.toLowerCase();
                  
                  if (existingGameIds.has(afGameId) || existingGameIds.has(matchKey)) {
                    skipCount++;
                    console.log(`⏭️ Skipping duplicate: ${game.home_team} vs ${game.away_team}`);
                    continue;
                  }

                  // Map snake_case API response to camelCase for admin API
                  const response = await fetch(`${apiUrl}/api/admin/games`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      phone: loggedInUser.phone,
                      gameId: afGameId,
                      league: game.league,
                      homeTeam: game.home_team,
                      awayTeam: game.away_team,
                      homeOdds: game.home_odds,
                      drawOdds: game.draw_odds,
                      awayOdds: game.away_odds,
                      time: game.time_eat || game.time_utc,
                      status: 'upcoming',
                      markets: game.markets
                    })
                  });

                  const data = await response.json();
                  if (data.success) {
                    successCount++;
                    // Track so we don't re-add in same batch
                    existingGameIds.add(afGameId);
                    existingGameIds.add(matchKey);
                    // Add to local games context
                    const gameData: GameOdds = {
                      id: data.game.game_id || data.game.id,
                      league: data.game.league || '',
                      homeTeam: data.game.home_team,
                      awayTeam: data.game.away_team,
                      homeOdds: parseFloat(data.game.home_odds),
                      drawOdds: parseFloat(data.game.draw_odds),
                      awayOdds: parseFloat(data.game.away_odds),
                      time: data.game.time || game.time_eat,
                      status: data.game.status || 'upcoming',
                      markets: data.game.markets || game.markets || {},
                    };
                    addGame(gameData);
                  } else {
                    failCount++;
                    console.error(`Failed to add ${game.home_team} vs ${game.away_team}:`, data.error);
                  }
                } catch (error) {
                  failCount++;
                  console.error(`Error adding ${game.home_team} vs ${game.away_team}:`, error);
                }
              }

              // Show result and refresh
              const parts = [`✅ Added ${successCount} games`];
              if (skipCount > 0) parts.push(`${skipCount} duplicates skipped`);
              if (failCount > 0) parts.push(`${failCount} failed`);
              alert(parts.join(', ') + '!');
              setShowFetchGamesModal(false);
              
              // Refresh games to sync with all users
              setTimeout(() => {
                refreshGames();
              }, 500);
            } catch (error) {
              console.error('Error executing games:', error);
              alert('Failed to add games. Check console for details.');
            }
          }}
        />

        {/* PIN Dialog for protected tabs */}
        <Dialog open={showPinDialog} onOpenChange={(open) => { if (!open) { setShowPinDialog(false); setPinInput(""); setPinError(""); } }}>
          <DialogContent className="sm:max-w-[360px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-primary" /> PIN Required
              </DialogTitle>
              <DialogDescription>
                Enter your admin PIN to access {pendingTab === "earnings" ? "Earnings" : "Transactions"}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Enter 6-digit PIN"
                value={pinInput}
                onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") handlePinSubmit(); }}
                className="text-center text-2xl tracking-[0.5em] font-mono"
                autoFocus
              />
              {pinError && (
                <p className="text-sm text-destructive font-medium text-center">{pinError}</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => { setShowPinDialog(false); setPinInput(""); setPinError(""); }}>
                  Cancel
                </Button>
                <Button variant="hero" className="flex-1" onClick={handlePinSubmit} disabled={pinInput.length < 6}>
                  Unlock
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default AdminPortal;




