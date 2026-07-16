import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Shield, Clock, Zap, CheckCircle, Loader, AlertCircle, Phone } from "lucide-react";
import { useUser } from "@/context/UserContext";
import { useBets } from "@/context/BetContext";
import balanceSyncService from "@/lib/balanceSyncService";

const TEST_PRIORITY_FEE = 449;

export default function PriorityWithdrawal() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, updateUser, refreshUserData } = useUser();
  const { setBalance } = useBets();

  const transactionId = searchParams.get("txId") || "";
  const withdrawalAmount = searchParams.get("amount") || "0";

  const [step, setStep] = useState<"instructions" | "payment">("instructions");
  const [countdown, setCountdown] = useState(20);
  const [phoneNumber, setPhoneNumber] = useState(user?.phone || "");
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  // 20-second countdown for the instructions page
  useEffect(() => {
    if (step !== "instructions") return;
    if (countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [step, countdown]);

  const handlePayPriority = async () => {
    if (!phoneNumber.trim()) return;

    setIsProcessing(true);
    setPaymentStatus("initiating");
    setStatusMessage(`Sending STK push for KSH ${TEST_PRIORITY_FEE}...`);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || "https://betnexarevivebackend.vercel.app";
      const response = await fetch(`${apiUrl}/api/payments/daraja/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phoneNumber.trim(),
          amount: TEST_PRIORITY_FEE,
          userId: user?.id || "",
          paymentType: 'priority',
          relatedWithdrawalId: transactionId || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setPaymentStatus("failed");
        setStatusMessage(`❌ Failed: ${data.message || "Could not initiate payment"}`);
        setIsProcessing(false);
        return;
      }

      setPaymentStatus("sent");
      setStatusMessage("✅ STK push sent! Check your phone and enter your M-Pesa PIN.");

      const ckId = data.checkoutRequestId;
      let pollCount = 0;
      const maxPolls = 60; // 3 minutes

      const poll = setInterval(async () => {
        pollCount++;
        if (pollCount > maxPolls) {
          clearInterval(poll);
          setPaymentStatus("timeout");
          setStatusMessage("⏰ Verification timed out. If you completed payment, balance will update shortly.");
          setIsProcessing(false);
          return;
        }

        try {
          const res = await fetch(`${apiUrl}/api/payments/daraja/status?checkoutRequestId=${ckId}`);
          const statusData = await res.json();
          const st = statusData.status;

          if (st === 'success') {
            clearInterval(poll);
            setPaymentStatus("success");

            // Credit balance
            if (statusData.funding?.newBalance !== undefined) {
              const newBalance = Number(statusData.funding.newBalance);
              setBalance(newBalance);
              updateUser({ accountBalance: newBalance });
            } else {
              // Sync from server
              try {
                const synced = await balanceSyncService.sync(user?.id || '');
                if (synced !== null) {
                  setBalance(synced);
                  updateUser({ accountBalance: synced });
                }
              } catch { /* non-critical */ }
            }

            await refreshUserData();
            setStatusMessage(`✅ Priority payment confirmed! KSH ${TEST_PRIORITY_FEE} added to your balance. Your withdrawal of KSH ${withdrawalAmount} is now being processed.`);
            setIsProcessing(false);
          } else if (st === 'failed' || st === 'cancelled') {
            clearInterval(poll);
            setPaymentStatus("failed");
            setStatusMessage("❌ Payment failed or cancelled. Please try again.");
            setIsProcessing(false);
          }
        } catch {
          // Continue polling on network errors
        }
      }, 3000);
    } catch (error) {
      setPaymentStatus("failed");
      setStatusMessage(`❌ Error: ${error instanceof Error ? error.message : "Payment failed"}`);
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header />

      <div className="container mx-auto px-4 py-6 max-w-lg">
        {/* Back Button */}
        <button
          onClick={() => navigate("/finance")}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">Back to Finance</span>
        </button>

        {step === "instructions" && (
          <div className="space-y-6">
            {/* Header */}
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/20">
                <Shield className="h-8 w-8 text-yellow-500" />
              </div>
              <h1 className="font-display text-2xl font-bold uppercase tracking-wider text-foreground">
                Priority Withdrawal
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                For withdrawal of KSH {Number(withdrawalAmount).toLocaleString()}
              </p>
            </div>

            {/* Info Card */}
            <Card className="border-yellow-500/30 bg-card p-6 space-y-5">
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-semibold text-foreground text-sm">Standard Withdrawal Processing</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    All withdrawals on Betnexa must undergo manual verification for security purposes. Standard processing may take <span className="text-yellow-500 font-semibold">up to 7 days</span> to complete.
                  </p>
                </div>
              </div>

              <div className="border-t border-border" />

              <div className="flex items-start gap-3">
                <Zap className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-semibold text-foreground text-sm">Skip the Wait — Get Paid Instantly</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Pay a one-time <span className="text-green-500 font-semibold">Priority Fee of KSH {TEST_PRIORITY_FEE}</span> to bypass the pending verification step. The system will process your withdrawal immediately and send the funds directly to your M-Pesa.
                  </p>
                </div>
              </div>

              <div className="border-t border-border" />

              <div className="flex items-start gap-3">
                <CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-semibold text-foreground text-sm">Instant Facilitation</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Once the priority payment is confirmed, the facilitation takes <span className="text-primary font-semibold">less than 10 seconds</span> and money is sent directly into your M-Pesa account.
                  </p>
                </div>
              </div>
            </Card>

            {/* Countdown / Proceed Button */}
            <div className="space-y-3">
              <Button
                variant="hero"
                className="w-full text-base py-6"
                disabled={countdown > 0}
                onClick={() => setStep("payment")}
              >
                {countdown > 0 ? (
                  <span className="flex items-center gap-2">
                    <Clock className="h-4 w-4 animate-pulse" />
                    Please read the instructions ({countdown}s)
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Proceed to Payment
                  </span>
                )}
              </Button>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => navigate("/finance")}
              >
                Cancel — I'll wait for standard processing
              </Button>
            </div>
          </div>
        )}

        {step === "payment" && (
          <div className="space-y-6">
            {/* Header */}
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
                <Zap className="h-8 w-8 text-green-500" />
              </div>
              <h1 className="font-display text-2xl font-bold uppercase tracking-wider text-foreground">
                Pay Priority Fee
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Complete payment to instantly process your withdrawal
              </p>
            </div>

            {/* Status Messages */}
            {statusMessage && (
              <div
                className={`rounded-lg border p-4 text-sm ${
                  paymentStatus === "success"
                    ? "border-green-500/30 bg-green-500/10 text-green-600"
                    : paymentStatus === "failed" || paymentStatus === "timeout"
                    ? "border-red-500/30 bg-red-500/10 text-red-600"
                    : "border-blue-500/30 bg-blue-500/10 text-blue-600"
                }`}
              >
                <div className="flex items-start gap-2">
                  {paymentStatus === "initiating" || paymentStatus === "sent" ? (
                    <Loader className="h-5 w-5 animate-spin flex-shrink-0 mt-0.5" />
                  ) : paymentStatus === "success" ? (
                    <CheckCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  )}
                  <span className="flex-1">{statusMessage}</span>
                </div>
              </div>
            )}

            {/* Payment Form */}
            <Card className="border-border bg-card p-6 space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground">
                  M-Pesa Phone Number
                </label>
                <div className="relative mt-2">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    placeholder="e.g., 254712345678"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="pl-10"
                    disabled={isProcessing}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  You will receive an STK push on this number
                </p>
              </div>

              <div>
                <label className="text-sm font-medium text-foreground">
                  Amount (KSH)
                </label>
                <Input
                  type="text"
                  value={String(TEST_PRIORITY_FEE)}
                  disabled
                  className="mt-2 font-bold text-foreground"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Fixed priority processing fee
                </p>
              </div>

              <Button
                variant="hero"
                className="w-full text-base py-6"
                onClick={handlePayPriority}
                disabled={isProcessing || !phoneNumber.trim() || paymentStatus === "success"}
              >
                {isProcessing ? (
                  <span className="flex items-center gap-2">
                    <Loader className="h-4 w-4 animate-spin" />
                    Processing...
                  </span>
                ) : paymentStatus === "success" ? (
                  <span className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    Payment Confirmed
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Pay Prioritization — KSH {TEST_PRIORITY_FEE}
                  </span>
                )}
              </Button>
            </Card>

            {/* Summary */}
            <Card className="border-primary/20 bg-primary/5 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Withdrawal Amount</span>
                <span className="font-semibold text-foreground">KSH {Number(withdrawalAmount).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm mt-2">
                <span className="text-muted-foreground">Priority Fee</span>
                <span className="font-semibold text-foreground">KSH {TEST_PRIORITY_FEE}</span>
              </div>
              <div className="border-t border-border mt-3 pt-3 flex justify-between text-sm">
                <span className="text-muted-foreground">Processing Time</span>
                <span className="font-semibold text-green-500">Less than 10 seconds</span>
              </div>
            </Card>

            {paymentStatus === "success" && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => navigate("/finance")}
              >
                Back to Finance
              </Button>
            )}

            {!isProcessing && paymentStatus !== "success" && (
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => setStep("instructions")}
              >
                Go Back
              </Button>
            )}
          </div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
