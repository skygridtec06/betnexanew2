import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, FileText, Plus, Sparkles, Trash2, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { jsPDF } from "jspdf";

type FinanceEntry = {
  id: string;
  date: string;
  earnings: number;
  spendings: number;
  notes: string;
};

const STORAGE_KEY = "betnexa_admin_finance_entries";

const money = (value: number) => `KSH ${Number(value || 0).toLocaleString()}`;

const loadEntries = (): FinanceEntry[] => {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to load finance entries:", error);
    return [];
  }
};

export default function AdminFinance() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    earnings: "",
    spendings: "",
    notes: "",
  });
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [pendingAction, setPendingAction] = useState<{ type: "add" | "delete"; id?: string } | null>(null);
  const ADMIN_PIN_HASH = "140702";

  const unlockFinanceAction = (action: { type: "add" | "delete"; id?: string }) => {
    setPendingAction(action);
    setPinInput("");
    setPinError("");
    setPinDialogOpen(true);
  };

  const confirmFinancePin = () => {
    if (pinInput === ADMIN_PIN_HASH) {
      setPinDialogOpen(false);
      setPinInput("");
      setPinError("");

      if (!pendingAction) return;

      if (pendingAction.type === "add") {
        handleAddEntry();
      }

      if (pendingAction.type === "delete" && pendingAction.id) {
        handleDeleteEntry(pendingAction.id);
      }

      setPendingAction(null);
      return;
    }

    setPinError("Incorrect PIN. Access denied.");
    setPinInput("");
  };

  useEffect(() => {
    setEntries(loadEntries());
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  }, [entries]);

  const filteredEntries = useMemo(() => {
    return [...entries]
      .filter((entry) => {
        if (!startDate || !endDate) return true;
        return entry.date >= startDate && entry.date <= endDate;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [entries, startDate, endDate]);

  const totals = useMemo(() => {
    return filteredEntries.reduce(
      (acc, entry) => {
        acc.earnings += Number(entry.earnings || 0);
        acc.spendings += Number(entry.spendings || 0);
        acc.net += Number(entry.earnings || 0) - Number(entry.spendings || 0);
        return acc;
      },
      { earnings: 0, spendings: 0, net: 0 }
    );
  }, [filteredEntries]);

  const handleBackNavigation = () => {
    if (window.history.length > 1 && document.referrer && document.referrer.includes(window.location.host)) {
      navigate(-1);
      return;
    }

    navigate("/muleiadmin");
  };

  const handleAddEntry = () => {
    const earnings = Number(form.earnings || 0);
    const spendings = Number(form.spendings || 0);

    if (!form.date) {
      alert("Please select a date.");
      return;
    }

    if (earnings <= 0 && spendings <= 0) {
      alert("Add at least one earnings or spending value.");
      return;
    }

    const newEntry: FinanceEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      date: form.date,
      earnings,
      spendings,
      notes: form.notes.trim(),
    };

    setEntries((prev) => [newEntry, ...prev].sort((a, b) => b.date.localeCompare(a.date)));
    setForm({
      date: new Date().toISOString().slice(0, 10),
      earnings: "",
      spendings: "",
      notes: "",
    });
  };

  const handleDeleteEntry = (id: string) => {
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  };

  const generateSummaryText = () => {
    if (totals.net >= 0) {
      return "The current period is in a healthy cash position. Keep pushing strong deposit channels, but avoid unnecessary discretionary spending until the buffer remains stable.";
    }

    return "Spending is currently overpowering earnings. Reduce discretionary expenses, tighten approval rules, and shift focus to revenue growth before approving more outflows.";
  };

  const exportPdf = () => {
    const doc = new jsPDF();
    const periodLabel = `${new Date(`${startDate}T00:00:00`).toLocaleDateString()} - ${new Date(`${endDate}T00:00:00`).toLocaleDateString()}`;

    doc.setFillColor(17, 24, 39);
    doc.rect(0, 0, 210, 26, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.text("Betnexa Financial Report", 14, 16);

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    doc.text(`Period: ${periodLabel}`, 14, 38);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 45);

    doc.setFontSize(12);
    doc.text("Summary", 14, 62);
    doc.setFontSize(10);
    doc.text(`Total earnings: ${money(totals.earnings)}`, 14, 72);
    doc.text(`Total spendings: ${money(totals.spendings)}`, 14, 80);
    doc.text(`Net result: ${money(totals.net)}`, 14, 88);

    doc.setFontSize(12);
    doc.text("AI Guidance", 14, 112);
    doc.setFontSize(10);
    const guidance = doc.splitTextToSize(generateSummaryText(), 175);
    doc.text(guidance, 14, 122);

    doc.setFontSize(12);
    doc.text("Daily Entries", 14, 160);
    doc.setFontSize(9);

    filteredEntries.slice(0, 12).forEach((entry, index) => {
      const y = 170 + index * 10;
      const line = `${entry.date}: earnings ${money(entry.earnings)} | spendings ${money(entry.spendings)} | notes ${entry.notes || "-"}`;
      const split = doc.splitTextToSize(line, 178);
      doc.text(split, 14, y);
    });

    doc.save(`betnexa-finance-report-${startDate}-to-${endDate}.pdf`);
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 text-white">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleBackNavigation} className="border-white/20 bg-white/5 text-white hover:bg-white/10">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-primary/80">Finance</p>
              <h1 className="text-3xl font-bold">Daily Financial Ledger</h1>
            </div>
          </div>
          <Button onClick={exportPdf} className="bg-primary text-primary-foreground">
            <Download className="mr-2 h-4 w-4" /> Export PDF
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-primary/30 bg-slate-900/80 p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300">Earnings</p>
              <TrendingUp className="h-5 w-5 text-emerald-400" />
            </div>
            <p className="mt-3 text-3xl font-bold text-emerald-400">{money(totals.earnings)}</p>
          </Card>

          <Card className="border-primary/30 bg-slate-900/80 p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300">Spendings</p>
              <TrendingDown className="h-5 w-5 text-rose-400" />
            </div>
            <p className="mt-3 text-3xl font-bold text-rose-400">{money(totals.spendings)}</p>
          </Card>

          <Card className="border-primary/30 bg-slate-900/80 p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300">Net</p>
              <Wallet className="h-5 w-5 text-primary" />
            </div>
            <p className={`mt-3 text-3xl font-bold ${totals.net >= 0 ? "text-emerald-400" : "text-amber-400"}`}>
              {money(totals.net)}
            </p>
          </Card>
        </div>

        <Card className="border-primary/30 bg-slate-900/80 p-5">
          <div className="mb-4 flex items-center gap-2 text-primary">
            <Plus className="h-4 w-4" />
            <h2 className="text-lg font-semibold">Add daily earnings and spending</h2>
          </div>

          <div className="grid gap-4 md:grid-cols-5">
            <div className="md:col-span-1">
              <label className="mb-1 block text-xs text-slate-400">Date</label>
              <Input type="date" value={form.date} onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Earnings</label>
              <Input type="number" min="0" value={form.earnings} onChange={(e) => setForm((prev) => ({ ...prev, earnings: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Spendings</label>
              <Input type="number" min="0" value={form.spendings} onChange={(e) => setForm((prev) => ({ ...prev, spendings: e.target.value }))} placeholder="0" />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs text-slate-400">Notes</label>
              <Input value={form.notes} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Campaign, rent, payroll, etc." />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={() => unlockFinanceAction({ type: "add" })} className="bg-primary text-primary-foreground">
              <Plus className="mr-2 h-4 w-4" /> Save Day
            </Button>
          </div>
        </Card>

        <Card className="border-primary/30 bg-slate-900/80 p-5">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Report range</p>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Start</label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">End</label>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
              </div>
            </div>
            <Badge className="bg-primary/10 text-primary">{filteredEntries.length} records</Badge>
          </div>

          <div className="rounded-xl border border-border/50 bg-slate-950/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-primary">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-semibold">AI guidance</span>
            </div>
            <p className="text-sm text-slate-200">{generateSummaryText()}</p>
          </div>

          <div className="mt-5 space-y-3">
            {filteredEntries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/50 p-6 text-center text-slate-400">
                No entries yet for this report range.
              </div>
            ) : (
              filteredEntries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-slate-700 bg-slate-950/50 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-base font-semibold text-white">{new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</p>
                      {entry.notes && <p className="text-xs text-slate-400">{entry.notes}</p>}
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-300">
                        <TrendingUp className="mr-1 inline h-3 w-3" /> {money(entry.earnings)}
                      </span>
                      <span className="rounded-full bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-300">
                        <TrendingDown className="mr-1 inline h-3 w-3" /> {money(entry.spendings)}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => unlockFinanceAction({ type: "delete", id: entry.id })} className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => window.close()} className="border-white/20 bg-white/5 text-white hover:bg-white/10">
            <FileText className="mr-2 h-4 w-4" /> Close Window
          </Button>
        </div>
      </div>

      {pinDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-primary/30 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Admin PIN required</h3>
            <p className="mt-2 text-sm text-slate-300">Enter the admin PIN to complete this finance change.</p>
            <Input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              className="mt-4"
              placeholder="Enter PIN"
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmFinancePin();
              }}
            />
            {pinError && <p className="mt-2 text-sm text-red-400">{pinError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => {
                setPinDialogOpen(false);
                setPinInput("");
                setPinError("");
                setPendingAction(null);
              }}>
                Cancel
              </Button>
              <Button onClick={confirmFinancePin} className="bg-primary text-primary-foreground">
                Unlock
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
