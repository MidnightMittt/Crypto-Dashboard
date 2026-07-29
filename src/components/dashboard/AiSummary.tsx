"use client";

import { useEffect, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AggregateMarketData } from "@/types/market";

export function AiSummary({ aggregate }: { aggregate: AggregateMarketData }) {
  const [summary, setSummary] = useState<string>("");
  const [source, setSource] = useState<"ai" | "rules">("rules");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/ai-summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aggregate }),
      });
      const data = await res.json();
      setSummary(data.summary ?? "");
      setSource(data.source ?? "rules");
    } catch {
      setSummary("Could not generate a summary. Check that the app can reach /api/ai-summary.");
    } finally {
      setLoading(false);
    }
  }

  // Regenerate when the asset changes, not on every poll — the narrative
  // doesn't need to churn every 10 seconds.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregate.asset]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber" />
          Market Read
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={source === "ai" ? "amber" : "neutral"}>
            {source === "ai" ? "AI" : "Rules-based"}
          </Badge>
          <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Regenerate summary">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <div className="p-4 pt-2">
        {loading && !summary ? (
          <div className="space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-white/5" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-white/5" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-white/5" />
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-ink-muted">{summary}</p>
        )}
        {source === "rules" && (
          <p className="mt-3 border-t border-hairline pt-3 text-[11px] text-ink-faint">
            Add <code className="text-cyan">ANTHROPIC_API_KEY</code> to <code>.env.local</code> for
            AI-written summaries. The rules-based version above works with no key.
          </p>
        )}
      </div>
    </Card>
  );
}
