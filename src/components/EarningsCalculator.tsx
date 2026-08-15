import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DollarSign, Calendar, RefreshCw, Download, X, Loader2 } from 'lucide-react';
import { useUser } from '@/context/UserContext';

interface EarningsData {
  startDate: string;
  endDate: string;
  totalDeposits: number;
  totalActivationFees: number;
  totalPriorityFees: number;
  masterTotal: number;
  depositCount: number;
  activationFeeCount: number;
  priorityFeeCount: number;
}

interface DailyEarnings {
  [date: string]: {
    deposits: number;
    activation: number;
    priority: number;
    total: number;
  };
}

interface DayTransaction {
  phone: string;
  username: string;
  amount: number;
  time: string;
  category: 'deposit' | 'activation' | 'priority';
}

export function EarningsCalculator() {
  const { user } = useUser();
  const [loading, setLoading] = useState(false);
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [dailyEarnings, setDailyEarnings] = useState<DailyEarnings>({});
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTransactions, setDayTransactions] = useState<DayTransaction[]>([]);
  const [dayLoading, setDayLoading] = useState(false);

  const adminPhone = user?.phone || '';

  // Initialize with today's date and fetch once user is available
  useEffect(() => {
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];
    setStartDate(dateString);
    setEndDate(dateString);

    if (adminPhone) {
      fetchEarnings(dateString, dateString);
    }
  }, [adminPhone]);

  const fetchEarnings = async (start: string, end: string) => {
    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const summaryResponse = await fetch(
        `${apiUrl}/api/admin/earnings?startDate=${start}&endDate=${end}&phone=${adminPhone}`,
        { headers: { 'Content-Type': 'application/json' }, method: 'GET' }
      );
      
      if (summaryResponse.ok) {
        const summaryData = await summaryResponse.json();
        if (summaryData.success) {
          setEarnings(summaryData.data);
        }
      } else {
        console.warn(`[Earnings] Earnings endpoint returned status ${summaryResponse.status}`);
      }
    } catch (err) {
      console.warn('[Earnings] Failed to fetch earnings summary:', err);
    }

    // Fetch daily breakdown (optional)
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const dailyResponse = await fetch(
        `${apiUrl}/api/admin/earnings/daily?startDate=${start}&endDate=${end}&phone=${adminPhone}`,
        { headers: { 'Content-Type': 'application/json' }, method: 'GET' }
      );
      
      if (dailyResponse.ok) {
        const dailyData = await dailyResponse.json();
        if (dailyData.success) {
          setDailyEarnings(dailyData.data);
        }
      }
    } catch (err) {
      console.warn('[Earnings] Failed to fetch daily breakdown:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchDayDetails = async (date: string) => {
    setSelectedDay(date);
    setDayLoading(true);
    setDayTransactions([]);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const res = await fetch(
        `${apiUrl}/api/admin/earnings/day-details?date=${date}&phone=${adminPhone}`,
        { headers: { 'Content-Type': 'application/json' }, method: 'GET' }
      );
      if (res.ok) {
        const json = await res.json();
        if (json.success) setDayTransactions(json.data);
      }
    } catch (err) {
      console.warn('[Earnings] Failed to fetch day details:', err);
    } finally {
      setDayLoading(false);
    }
  };

  const handleSetToday = () => {
    const today = new Date().toISOString().split('T')[0];
    setStartDate(today);
    setEndDate(today);
    fetchEarnings(today, today);
  };

  const handleSetThisMonth = () => {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const start = firstDay.toISOString().split('T')[0];
    const end = today.toISOString().split('T')[0];
    setStartDate(start);
    setEndDate(end);
    fetchEarnings(start, end);
  };

  const handleSetLastMonth = () => {
    const today = new Date();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const start = lastMonth.toISOString().split('T')[0];
    const end = lastMonthEnd.toISOString().split('T')[0];
    setStartDate(start);
    setEndDate(end);
    fetchEarnings(start, end);
  };

  const handleApplyFilter = () => {
    if (startDate && endDate) {
      fetchEarnings(startDate, endDate);
    }
  };

  const handleExportCSV = () => {
    if (!earnings) return;

    let csv = 'Earnings Report\n';
    csv += `Period,${new Date(earnings.startDate).toLocaleDateString()} - ${new Date(earnings.endDate).toLocaleDateString()}\n`;
    csv += '\nTransaction Type,Amount (KSH),Count\n';
    csv += `Deposits,${earnings.totalDeposits},${earnings.depositCount}\n`;
    csv += `Activation Fees,${earnings.totalActivationFees},${earnings.activationFeeCount}\n`;
    csv += `Priority Fees,${earnings.totalPriorityFees},${earnings.priorityFeeCount}\n`;
    csv += `\nMaster Total,${earnings.masterTotal}\n`;

    if (Object.keys(dailyEarnings).length > 0) {
      csv += '\n\nDaily Breakdown\n';
      csv += 'Date,Deposits,Activation Fees,Priority Fees,Daily Total\n';
      Object.keys(dailyEarnings)
        .sort()
        .forEach(date => {
          const day = dailyEarnings[date];
          csv += `${date},${day.deposits},${day.activation},${day.priority},${day.total}\n`;
        });
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `earnings-${startDate}-${endDate}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">
          Earnings Calculator
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          View total completed deposits, activation fees, and priority fees with date filtering
        </p>
      </div>

      {/* Date Filter Section */}
      <Card className="border-primary/20 bg-card/50 p-4 neon-border">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            <h4 className="font-display text-xs font-bold uppercase text-foreground">Date Range</h4>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Start Date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">End Date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleApplyFilter}
                disabled={loading}
                size="sm"
                className="w-full"
              >
                {loading ? (
                  <>
                    <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Loading...
                  </>
                ) : (
                  'Apply'
                )}
              </Button>
            </div>
          </div>

          {/* Quick Filter Buttons */}
          <div className="flex flex-wrap gap-2 border-t border-primary/10 pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSetToday}
              className="text-xs"
            >
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSetThisMonth}
              className="text-xs"
            >
              This Month
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSetLastMonth}
              className="text-xs"
            >
              Last Month
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              disabled={!earnings}
              className="ml-auto text-xs"
            >
              <Download className="mr-1 h-3 w-3" /> Export CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary Cards */}
      {earnings && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
          {/* Total Deposits */}
          <Card className="border-blue-500/30 bg-gradient-to-br from-blue-500/5 to-blue-600/5 p-4 neon-border">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Total Deposits</p>
                <p className="mt-2 font-display text-2xl font-bold text-blue-400">
                  KSH {earnings.totalDeposits.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {earnings.depositCount} transaction{earnings.depositCount !== 1 ? 's' : ''}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-blue-400 opacity-30" />
            </div>
          </Card>

          {/* Activation Fees */}
          <Card className="border-green-500/30 bg-gradient-to-br from-green-500/5 to-green-600/5 p-4 neon-border">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Activation Fees</p>
                <p className="mt-2 font-display text-2xl font-bold text-green-400">
                  KSH {earnings.totalActivationFees.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {earnings.activationFeeCount} transaction{earnings.activationFeeCount !== 1 ? 's' : ''}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-green-400 opacity-30" />
            </div>
          </Card>

          {/* Priority Fees */}
          <Card className="border-orange-500/30 bg-gradient-to-br from-orange-500/5 to-orange-600/5 p-4 neon-border">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Priority Fees</p>
                <p className="mt-2 font-display text-2xl font-bold text-orange-400">
                  KSH {earnings.totalPriorityFees.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {earnings.priorityFeeCount} transaction{earnings.priorityFeeCount !== 1 ? 's' : ''}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-orange-400 opacity-30" />
            </div>
          </Card>

          {/* Master Total - Spans 2 columns on larger screens */}
          <Card className="border-primary/50 bg-gradient-to-br from-primary/10 to-primary/5 p-4 neon-border md:col-span-2 lg:col-span-1">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Master Total</p>
                <p className="mt-2 font-display text-2xl font-bold text-primary">
                  KSH {earnings.masterTotal.toLocaleString()}
                </p>
                <Badge className="mt-2 bg-primary/30 text-primary" variant="outline">
                  All Earnings
                </Badge>
              </div>
              <DollarSign className="h-8 w-8 text-primary opacity-30" />
            </div>
          </Card>
        </div>
      )}

      {/* Daily Breakdown Calendar */}
      {Object.keys(dailyEarnings).length > 0 && (
        <Card className="border-primary/20 bg-card/50 p-4 neon-border">
          <div className="mb-4 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            <h4 className="font-display text-xs font-bold uppercase text-foreground">Daily Breakdown</h4>
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {Object.keys(dailyEarnings)
              .sort()
              .map((date) => {
                const day = dailyEarnings[date];
                const dateObj = new Date(date);
                const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });

                return (
                  <div
                    key={date}
                    onClick={() => fetchDayDetails(date)}
                    className="cursor-pointer rounded-lg border border-primary/20 bg-secondary/30 p-3 hover:border-primary/40 hover:bg-secondary/50 active:scale-[0.98] transition"
                  >
                    <p className="text-xs font-semibold text-primary">
                      {dayName}, {date}
                    </p>
                    <div className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Deposits:</span>
                        <span className="text-blue-400 font-semibold">KSH {day.deposits.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Activation:</span>
                        <span className="text-green-400 font-semibold">KSH {day.activation.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Priority:</span>
                        <span className="text-orange-400 font-semibold">KSH {day.priority.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="mt-3 border-t border-primary/10 pt-2">
                      <div className="flex justify-between">
                        <span className="font-semibold text-foreground">Total:</span>
                        <span className="font-bold text-primary">{day.total.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      )}

      {/* Day Transaction Details */}
      {selectedDay && (
        <Card className="border-primary/20 bg-card/50 p-4 neon-border">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="font-display text-xs font-bold uppercase text-foreground">
              Transactions â€” {selectedDay}
            </h4>
            <button
              onClick={() => { setSelectedDay(null); setDayTransactions([]); }}
              className="rounded-full p-1 hover:bg-secondary transition"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {dayLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading...</span>
            </div>
          ) : dayTransactions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No transactions found</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-primary/20">
                    <th className="pb-2 text-left font-semibold text-muted-foreground">Phone</th>
                    <th className="pb-2 text-left font-semibold text-muted-foreground">Username</th>
                    <th className="pb-2 text-right font-semibold text-muted-foreground">Amount</th>
                    <th className="pb-2 text-left font-semibold text-muted-foreground">Type</th>
                    <th className="pb-2 text-right font-semibold text-muted-foreground">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {dayTransactions.map((tx, i) => (
                    <tr key={i} className="border-b border-primary/10 last:border-0">
                      <td className="py-2 text-foreground">{tx.phone}</td>
                      <td className="py-2 text-foreground">{tx.username}</td>
                      <td className="py-2 text-right font-semibold">
                        <span className={
                          tx.category === 'deposit' ? 'text-blue-400' :
                          tx.category === 'activation' ? 'text-green-400' : 'text-orange-400'
                        }>
                          KSH {tx.amount.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2">
                        <Badge variant="outline" className={
                          tx.category === 'deposit' ? 'border-blue-400/30 text-blue-400' :
                          tx.category === 'activation' ? 'border-green-400/30 text-green-400' :
                          'border-orange-400/30 text-orange-400'
                        }>
                          {tx.category}
                        </Badge>
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {new Date(tx.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Empty State */}
      {!earnings && !loading && (
        <Card className="border-primary/20 bg-card/50 p-8 text-center neon-border">
          <p className="text-muted-foreground">Select a date range and click "Apply" to view earnings</p>
        </Card>
      )}
    </div>
  );
}
