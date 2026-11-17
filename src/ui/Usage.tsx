import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useEffect, useState } from "react";
import type { AssistantAccount } from "../shared/types";
import type { AccountUsage, UsageWindow } from "../shared/usage";
import { api } from "./model";
import { remainingTone, type Tone } from "./primitives";
import { Bar, cx } from "./rz";

export type AccountUsageState = {
  usage: AccountUsage | null; // only ever the measurement of THIS account
  loading: boolean;
  failed: boolean;
  stale: boolean;
  now: number;
};
export const formatUsageTime = (date: string) =>
  new Date(date).toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
// Decision D11: the friendly names are for exactly the plain 5 h / 7 d windows. Model and bucket windows
// ("Opus · 7 dagen") and every aria-label keep the label the runtime reports.
const windowLabel = (w: UsageWindow) =>
  w.label === "5 uur"
    ? tr("Komende 5 uur")
    : w.label === "7 dagen"
      ? tr("Deze week")
      : translateMessage(w.label);

// One fetch per account: a page that also needs plan / checked times (Accounts) calls the hook itself and
// hands the state to AccountUsageView; everyone else uses AccountUsagePanel.
export function useAccountUsage(
  account: AssistantAccount,
  refreshKey = 0,
): AccountUsageState {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let disposed = false,
      busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      setLoading(true);
      setFailed(false);
      try {
        const next = await api<AccountUsage>("accounts.usage", {
          id: account.id,
          force: refreshKey > 0,
        });
        if (!disposed) {
          setUsage(next);
          setNow(Date.now());
        }
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void refresh();
    }, 300_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    account.id,
    account.configDir,
    account.email,
    account.status,
    refreshKey,
  ]);
  const current = usage?.accountId === account.id ? usage : null;
  const stale =
    failed ||
    current?.state === "stale" ||
    (!!current?.updatedAt && now - Date.parse(current.updatedAt) > 600_000);
  return { usage: current, loading, failed, stale, now };
}

// Default = row stack (Accounts table cell). compact = auto-fit grid for the account block of the task wizard
// and the launcher (put it inside an `rz-inset`; it has no surface of its own).
export function AccountUsageView({
  account,
  state,
  compact = false,
  remaining = false,
}: {
  account: AssistantAccount;
  state: AccountUsageState;
  compact?: boolean;
  remaining?: boolean;
}) {
  const { usage, loading, failed, stale, now } = state;
  const needsLogin =
    account.status === "logged_out" || account.status === "expired";
  return (
    <div
      className={cx("rz-usage", compact && "rz-usage--compact")}
      data-test="account-usage"
      role="group"
      aria-label={tr("Gebruik van {0}", account.label)}
      aria-busy={loading}
    >
      {usage?.windows.length ? (
        <>
          <div className="rz-usage__windows">
            {usage.windows.map((w) => {
              const expired = !!w.resetsAt && Date.parse(w.resetsAt) <= now;
              const old = stale || expired;
              const used = Math.round(w.usedPercent * 10) / 10;
              const left = Math.max(
                0,
                Math.min(100, Math.round((100 - used) * 10) / 10),
              );
              const shown = remaining ? left : Math.min(100, used);
              const tone: Tone = remaining
                ? remainingTone(left)
                : used >= 90
                  ? "warn"
                  : "accent";
              const reset = expired
                ? tr("Resetmoment verstreken · nieuwe meting nodig")
                : w.resetsAt
                  ? tr("Reset {0}", formatUsageTime(w.resetsAt))
                  : tr("Resetmoment niet beschikbaar");
              // Calm at rest: the reset moment is a tooltip, and becomes a quiet line once it matters
              // (the window is nearly used up, or its reset moment passed without a new measurement).
              const urgent = remaining ? tone === "danger" : used >= 90;
              return (
                <div
                  className="rz-meter rz-meter--usage rz-usage__window"
                  data-tone={tone}
                  data-stale={old ? "" : undefined}
                  title={[
                    reset,
                    old && usage.updatedAt
                      ? tr("Bijgewerkt {0}", formatUsageTime(usage.updatedAt))
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  key={w.id}
                >
                  <div className="rz-meter__top rz-usage__top">
                    <span className="rz-usage__label">{windowLabel(w)}</span>
                    <span className="rz-meter__value rz-usage__value rz-num">
                      {remaining
                        ? tr("{0}% over{1}", Math.round(left), "")
                        : tr(
                            "{0}% gebruikt · {1}% over{2}",
                            Math.round(used),
                            Math.round(left),
                            "",
                          )}
                      {old && (
                        <span className="rz-usage__old">
                          {tr(" (laatste meting)")}
                        </span>
                      )}
                    </span>
                  </div>
                  <Bar
                    pct={shown}
                    tone={tone}
                    label={`${translateMessage(w.label)} ${remaining ? tr("over") : tr("gebruikt")}${old ? tr(" bij laatste meting") : ""}`}
                    aria-valuenow={shown}
                  />
                  {(expired || (urgent && w.resetsAt)) && (
                    <span className="rz-usage__note">{reset}</span>
                  )}
                </div>
              );
            })}
          </div>
          {usage.blocked && (
            <p className="rz-usage__note" data-tone="warn">
              {tr("De provider meldt dat een accountlimiet is bereikt.")}
            </p>
          )}
          {stale && (
            <p className="rz-usage__note">
              {failed
                ? tr("Vernieuwen is niet gelukt. Dit is de laatste meting.")
                : translateMessage(usage.message) ||
                  tr(
                    "Dit is de laatste meting; vernieuw voor actuele gegevens.",
                  )}
            </p>
          )}
        </>
      ) : (
        <p className="rz-usage__message">
          {needsLogin
            ? tr("Log in om gebruik te zien")
            : loading
              ? tr("Gebruik ophalen…")
              : failed
                ? tr(
                    "Gebruik kon niet worden opgehaald. Probeer het later opnieuw.",
                  )
                : translateMessage(usage?.message || "") ||
                  tr("Nog geen gebruiksgegevens beschikbaar.")}
        </p>
      )}
    </div>
  );
}

export function AccountUsagePanel({
  account,
  refreshKey = 0,
  compact = false,
  remaining = false,
}: {
  account: AssistantAccount;
  refreshKey?: number;
  compact?: boolean;
  remaining?: boolean;
}) {
  return (
    <AccountUsageView
      account={account}
      state={useAccountUsage(account, refreshKey)}
      compact={compact}
      remaining={remaining}
    />
  );
}
