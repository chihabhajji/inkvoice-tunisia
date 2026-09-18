import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { todayIso } from "@/lib/date";
import { formatApiError } from "@/lib/format-api-error";
import { formatCurrency, moneyDecimals, roundMoney } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  balanceDue: number;
  currency: string;
  /** Early-payment discount offer on the invoice, when configured. */
  cashDiscount?: {
    type: string | null;
    value: number;
    days: number;
    issueDate: string;
  } | null;
  onSuccess: () => void;
}

function addDaysIso(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  invoiceId,
  balanceDue,
  currency,
  cashDiscount = null,
  onSuccess,
}: Props) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(balanceDue);
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [applyDiscount, setApplyDiscount] = useState(false);
  const [loading, setLoading] = useState(false);

  const discountInfo = useMemo(() => {
    if (!cashDiscount || !cashDiscount.type || cashDiscount.days <= 0) {
      return { available: false, amount: 0, deadline: null };
    }
    const amount =
      cashDiscount.type === "amount"
        ? Math.min(cashDiscount.value, balanceDue)
        : roundMoney((balanceDue * cashDiscount.value) / 100, currency);
    return {
      available: balanceDue > 0,
      amount,
      deadline: addDaysIso(cashDiscount.issueDate, cashDiscount.days),
    };
  }, [cashDiscount, balanceDue, currency]);

  const discountEligible =
    discountInfo.available && !!discountInfo.deadline && paymentDate <= discountInfo.deadline;

  useEffect(() => {
    if (open) {
      setAmount(balanceDue);
      setPaymentDate(todayIso());
      setReference("");
      setNotes("");
      setApplyDiscount(false);
    }
  }, [open, balanceDue]);

  const discountedAmount = discountEligible
    ? roundMoney(Math.max(0, balanceDue - discountInfo.amount), currency)
    : balanceDue;

  const handleToggleDiscount = (checked: boolean) => {
    setApplyDiscount(checked);
    setAmount(checked ? discountedAmount : balanceDue);
  };

  const handleSubmit = async () => {
    if (!amount || amount <= 0) {
      toast.error(t("record_payment.amount_error"));
      return;
    }
    setLoading(true);
    try {
      await api.recordPayment(invoiceId, {
        amount,
        payment_date: paymentDate,
        method,
        reference: reference || undefined,
        notes: notes || undefined,
        apply_cash_discount: applyDiscount ? true : undefined,
      });
      toast.success(t("record_payment.recorded"));
      onOpenChange(false);
      onSuccess();
    } catch (err: unknown) {
      toast.error(formatApiError(err, t));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("record_payment.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <FormField
            label={t("record_payment.amount")}
            hint={t("record_payment.balance_due", { amount: formatCurrency(balanceDue, currency) })}
          >
            <NumberInput
              value={amount}
              min={10 ** -moneyDecimals(currency)}
              decimals={moneyDecimals(currency)}
              onValueChange={setAmount}
            />
            {amount > balanceDue && (
              <p className="text-xs text-amber-600 mt-1">{t("record_payment.exceeds_balance")}</p>
            )}
          </FormField>
          <FormField label={t("record_payment.payment_date")}>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => {
                const nextDate = e.target.value;
                setPaymentDate(nextDate);
                if (applyDiscount) {
                  const stillEligible =
                    discountInfo.available &&
                    !!discountInfo.deadline &&
                    nextDate <= discountInfo.deadline;
                  setAmount(
                    stillEligible
                      ? roundMoney(Math.max(0, balanceDue - discountInfo.amount), currency)
                      : balanceDue,
                  );
                }
              }}
            />
          </FormField>
          {discountInfo.available && discountInfo.deadline && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={applyDiscount}
                disabled={!discountEligible}
                onChange={(e) => handleToggleDiscount(e.target.checked)}
                className="rounded"
              />
              <span>
                <span className="font-medium">{t("record_payment.apply_cash_discount")}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {t("record_payment.cash_discount_detail", {
                    amount: formatCurrency(discountInfo.amount, currency),
                    deadline: discountInfo.deadline,
                  })}
                  {!discountEligible && ` · ${t("record_payment.cash_discount_expired")}`}
                </span>
              </span>
            </label>
          )}
          <FormField label={t("record_payment.method")}>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="form-select"
            >
              <option value="bank_transfer">{t("record_payment.method_bank")}</option>
              <option value="cash">{t("record_payment.method_cash")}</option>
              <option value="card">{t("record_payment.method_card")}</option>
              <option value="check">{t("record_payment.method_check")}</option>
              <option value="credit">{t("record_payment.method_credit")}</option>
              <option value="other">{t("record_payment.method_other")}</option>
            </select>
          </FormField>
          <FormField label={t("record_payment.reference")}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("common.optional")}
            />
          </FormField>
          <FormField label={t("record_payment.notes")}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={t("common.optional")}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {t("record_payment.record")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
