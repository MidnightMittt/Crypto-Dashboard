"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/Dialog";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { ALERT_PRESETS, evaluateAll } from "@/lib/alerts/engine";
import { AggregateMarketData, AlertChannel, AlertFiring, AlertRule } from "@/types/market";

const CHANNELS: AlertChannel[] = ["browser", "sound", "discord", "telegram", "email"];

export function AlertsPanel({ aggregate }: { aggregate: AggregateMarketData }) {
  const { rules, addRule, removeRule, toggleRule, markTriggered, asset } = useDashboardStore();
  const [firings, setFirings] = useState<AlertFiring[]>([]);
  const previousRef = useRef<AggregateMarketData | undefined>(undefined);
  const [email, setEmail] = useState("");

  // Evaluate rules on every new aggregate.
  useEffect(() => {
    const matches = evaluateAll(rules, { current: aggregate, previous: previousRef.current });

    matches.forEach(({ rule, message }) => {
      markTriggered(rule.id);
      setFirings((f) => [{ ruleId: rule.id, message, t: Date.now() }, ...f].slice(0, 20));

      if (rule.channels.includes("browser") && typeof Notification !== "undefined") {
        if (Notification.permission === "granted") {
          new Notification("Leverage Terminal", { body: message });
        }
      }
      if (rule.channels.includes("sound")) {
        playBeep();
      }
      const serverChannels = rule.channels.filter((c) => c === "discord" || c === "telegram" || c === "email");
      if (serverChannels.length) {
        fetch("/api/alerts/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, channels: serverChannels, email }),
        }).catch(() => undefined);
      }
    });

    previousRef.current = aggregate;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregate]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-3.5 w-3.5 text-cyan" />
          Alerts
        </CardTitle>
        <NewRuleDialog
          asset={asset}
          onCreate={(rule) => {
            addRule(rule);
            if (rule.channels.includes("browser") && typeof Notification !== "undefined") {
              Notification.requestPermission().catch(() => undefined);
            }
          }}
        />
      </CardHeader>

      <div className="flex flex-col gap-2 p-4 pt-2">
        {rules.length === 0 && (
          <div className="rounded-lg border border-dashed border-hairline py-6 text-center">
            <p className="text-sm text-ink-muted">No alerts yet.</p>
            <p className="mt-1 text-xs text-ink-faint">
              Start with “Price flat while OI rises” — it catches leverage building before a move.
            </p>
          </div>
        )}

        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-white/[0.02] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm text-ink">{rule.label}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                <Badge variant="cyan">{rule.asset}</Badge>
                {rule.channels.map((c) => (
                  <Badge key={c}>{c}</Badge>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch checked={rule.enabled} onCheckedChange={() => toggleRule(rule.id)} />
              <Button variant="ghost" size="icon" onClick={() => removeRule(rule.id)} aria-label="Delete alert">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}

        {rules.some((r) => r.channels.includes("email")) && (
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Delivery email address"
            className="h-9 rounded-md border border-hairline bg-panel px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:ring-2 focus:ring-cyan/40"
          />
        )}

        {firings.length > 0 && (
          <div className="mt-2 border-t border-hairline pt-3">
            <div className="mb-2 text-[10px] uppercase tracking-wide text-ink-faint">Recent firings</div>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {firings.map((f, i) => (
                <div key={`${f.ruleId}-${f.t}-${i}`} className="rounded bg-cyan/5 px-2 py-1.5 text-xs text-ink-muted">
                  {f.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function NewRuleDialog({
  asset,
  onCreate,
}: {
  asset: AlertRule["asset"];
  onCreate: (rule: AlertRule) => void;
}) {
  const [presetIdx, setPresetIdx] = useState("0");
  const [channels, setChannels] = useState<AlertChannel[]>(["browser"]);
  const [open, setOpen] = useState(false);

  function submit() {
    const preset = ALERT_PRESETS[Number(presetIdx)];
    onCreate({
      id: crypto.randomUUID(),
      label: preset.label,
      asset,
      metric: preset.metric,
      threshold: preset.threshold,
      channels,
      enabled: true,
      createdAt: Date.now(),
    });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          New alert
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle className="text-sm font-semibold text-ink">Create alert</DialogTitle>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-xs text-ink-muted">Condition</label>
            <Select value={presetIdx} onValueChange={setPresetIdx}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_PRESETS.map((p, i) => (
                  <SelectItem key={p.label} value={String(i)}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-ink-muted">Deliver via</label>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((c) => {
                const active = channels.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() =>
                      setChannels((prev) => (active ? prev.filter((x) => x !== c) : [...prev, c]))
                    }
                    className={`rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors ${
                      active
                        ? "border-cyan/40 bg-cyan/10 text-cyan"
                        : "border-hairline text-ink-muted hover:text-ink"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">
              Browser and sound work immediately. Discord, Telegram, and email need their keys in{" "}
              <code>.env.local</code>.
            </p>
          </div>

          <Button onClick={submit} disabled={channels.length === 0}>
            Create alert
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Short synthesized beep — avoids shipping an audio asset. */
function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {
    // Autoplay blocked until the user interacts with the page — expected.
  }
}
