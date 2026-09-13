/**
 * Version stamping for backtest outputs.
 *
 * This exists because of a real defect, not as bookkeeping. The committed
 * backtestStats.json was last regenerated at commit c92845f, after which
 * FIVE commits changed the decision engine without anyone regenerating it
 * — including the one that redefined "Mixed / Low Conviction" as a strict
 * tie. The live dashboard spent that whole stretch reporting N=306 days for
 * a bucket the shipped engine actually puts at 13, and nothing in the data
 * made that detectable.
 *
 * A published statistic that can't be traced to the logic that produced it
 * is worse than no statistic: it looks authoritative while describing
 * something that no longer exists. Every output file now carries this
 * stamp, so staleness is visible instead of silent.
 */

import { DEFAULT_COST_CONFIG, CostConfig } from "./costs";

/**
 * Bump when any change alters what the engine WOULD HAVE DECIDED on a
 * historical day — scoring weights, evaluator thresholds, the action gate,
 * entry/stop/target placement, regime classification.
 *
 * Do NOT bump for presentation, comments, or report formatting: an
 * inflated version is as misleading as a stale one, just in the other
 * direction.
 *
 * 4.0.0: Phase 4 retired the regime weight multipliers after ablation
 * showed they did not earn their place. This changes what the engine would
 * have decided on 116 of 2,896 historical days, so it is a major bump even
 * though the diff is a handful of emptied objects.
 *
 * 5.0.0: `longShort` left the Edge roster. It was never a second opinion —
 * it read the same long/short ratio `squeezeRisk` reads and mapped it to the
 * opposite verdict, so on all 1,181 replay observations where both took a
 * position they took opposite ones and the pair netted 0.14 − 0.08 = 0.06
 * instead of voting 0.22. Removing it restores squeezeRisk to full weight
 * and stops the leverage cluster registering a manufactured disagreement.
 *
 * Measured on the same 2,896 replayed days, old engine vs new: 2,449 days
 * rescored (mean |delta| 1.7 points), 216 verdicts flipped, 395 actions
 * changed, and mean agreement rose 38.9 -> 49.3 — that last figure is the
 * manufactured split going away, not the market agreeing more.
 *
 * It cost in-sample expectancy: 0.42% -> 0.21% net per trade, profit factor
 * 1.19 -> 1.10. That is NOT evidence the change was wrong. Overlap-corrected
 * (6-day blocks, 138h median hold) the standard error on expectancy is
 * 0.37pp, so the two numbers are 0.6 SE apart and NEITHER is distinguishable
 * from zero. What the drop actually shows is how much of the old record
 * rested on a weight — 0.06 — that no one chose.
 *
 * 6.0.0: `spotPerpVolume` left the Edge roster too, and for a worse reason
 * than longShort's. Its verdict was not merely correlated with Price Action's
 * — it WAS Price Action's, read straight off `ctx.technicals.direction` and
 * gated on spot participation. Price Action is role "state"; it does not vote,
 * because the module census graded it at 49.1% at 4h against a 49.9% base rate
 * on nEff 1098. Its direction was nonetheless reaching the composite at weight
 * 0.05 under a volume label, and not even faithfully: the price row reports
 * neutral below trend strength 20 and this gate did not, so on 417 of 2,896
 * replayed days the wrapper published a direction Price Action had declined to
 * call. Over the 1,648 days where both took a direction they agreed 1,648
 * times — rho +1.000, zero opposed cells.
 *
 * The metric is now permanently neutral and role "context". The turnover mix
 * it measures is real information about how DURABLE a move is, so it moved to
 * the row it qualifies: evaluateTechnicals raises the leverage-led case as a
 * conflict on Price Action.
 *
 * Measured on the same 2,896 replayed days, 5.0.0 vs 6.0.0: the wrapper took
 * a direction on 2,065 of them (71%), so removing it rescored 2,620 days
 * (mean |delta| 3.5 points, max 10.0), flipped 549 verdicts and changed 308
 * actions — a LARGER decision delta than 5.0.0's, from a smaller weight.
 *
 * The reason is not the 0.05. The headline score is category-weighted, and
 * spotPerpVolume was the only voting metric left in `marketStructure`. With
 * it gone that category scores null, `combineCategoryScores` skips it, and
 * its 0.25 renormalizes across the other three — taking positioning from
 * 0.35 to 0.467. The composite did not lose a small vote; it lost a quarter
 * of its category structure, and that quarter had been resting on one
 * wrapper of a non-voting read. See CATEGORY_WEIGHTS in categories.ts.
 *
 * The record barely moves: 1,218 -> 1,130 resolved trades, net expectancy
 * 0.206% -> 0.153%, profit factor 1.098 -> 1.072. Overlap-corrected (6-day
 * blocks against the 138h median hold, 194 blocks) the SE on expectancy is
 * 0.31pp, so the 0.053pp drop is 0.16 SE and neither figure is
 * distinguishable from zero. Naive sd/sqrt(n) would have said 0.17pp — still
 * the ~2x understatement that made this correction necessary in the first
 * place.
 *
 * Module breadth drops from 12 correlatable modules to 11 and the +1.000 pair
 * is gone. `squeezeRisk / longShort` still prints at -1.000: 5.0.0 stopped
 * longShort VOTING, not describing, so it still occupies a census slot. See
 * moduleBreadth.ts.
 *
 * 7.0.0: `technicals` stopped voting in the SECOND engine. 6.0.0 removed a
 * wrapper that was laundering Price Action's direction into the Edge
 * composite; this removes Price Action's direction from marketThesis.ts,
 * where it had been voting openly at 0.14 — the second-largest pillar — the
 * whole time. Same read, two engines, opposite answers to "may this signal
 * speak?" The census says no at every horizon it was graded on: 48.84% /
 * 49.11% / 47.97% at 1h / 4h / 24h against base rates of 49.99% / 49.93% /
 * 50.04%, n=2,195, nothing significant. See the WEIGHTS doc in
 * lib/sentiment/marketThesis.ts for why that reads as "no evidence of edge"
 * rather than "contrarian signal."
 *
 * ── This bumps because of the action gate, not the score ───────────────
 *
 * Measured 6.0.0 vs 7.0.0 over the same 2,896 days: `biasScore`,
 * `biasVerdict`, `biasConfidence` and `biasAgreement` are byte-identical on
 * every single day. Zero. The thesis genuinely is a separate object from the
 * category-weighted composite and does not feed it.
 *
 * It does feed the TRADE GATE. buildTradeRecommendation blocks a trade when
 * `thesis.dominant` opposes the bias direction (blockingLayer: "thesis"), so
 * moving 0.14 out of the thesis changed `action` on 263 days and the
 * entry/stop/target triplet on 73. That is a change to what the engine would
 * have DONE on a historical day, which is the bump rule, even though what it
 * would have SAID is untouched.
 *
 * ── Every one of those 263 days is on the long side ────────────────────
 *
 *   enter-long   171 -> 98   (-73, all to no-trade)
 *   enter-short  959 -> 959  (zero change)
 *
 * This is not a coincidence and it is not caused here. The thesis fades
 * crowded positioning, and crypto funding is positive most of the time, so
 * the thesis reads bearish or squeeze-bearish on 75.1% of replayed days and
 * bullish on 12.6%. Price action was the one input that could push it
 * bullish; without it the split is 76.2% / 5.0%. A veto that points one way
 * 76% of the time and the other way 5% is close to an unconditional veto on
 * longs, and this change sharpened an asymmetry that was already there.
 *
 * The fix for that is in tradeRecommendation.ts, not here, and it needs its
 * own measurement. Keeping an ungraded input in the thesis to counterweight
 * a lopsided gate would be two wrongs, not one right.
 *
 * ── "Trending" is now unreachable in the replay, and that is the finding ─
 *
 * Trending Bearish 641 -> 0, Trending Bullish 8 -> 0. Not rare — zero.
 *
 * `conviction` is agreement x PARTICIPATION, and participation is the share
 * of present weight that is directional at all. In the replay four of the
 * seven remaining sources have no historical archive and drop out, and
 * `funding` — the largest surviving weight at 0.17 — sits inside the
 * +/-0.04%/8h neutral band on 2,863 of 2,896 days, because FUNDING_BANDS is
 * calibrated for the live OI-weighted multi-venue composite and the replay
 * has single-venue Binance. So the replayed thesis is squeezeRisk 0.16 plus
 * basis 0.10 directional against funding 0.17 sitting neutral: participation
 * caps at 0.26/0.43 = 0.605, and conviction caps at 6. REGIME_TREND_
 * CONVICTION is 7.
 *
 * Adding technicals' 0.14 to the numerator was what cleared it. Checked
 * rather than assumed: of the 649 old Trending days, price action was
 * directional on 649. 100%. Every "Trending Bearish" this engine ever
 * printed in the replay was manufactured by the participation contribution
 * of a signal with no measured edge.
 *
 * Live is a different object — seven directional sources, real multi-venue
 * funding — so Trending remains reachable there. DO NOT reconcile the two by
 * lowering REGIME_TREND_CONVICTION against the replay's distribution; that
 * would restore the label by fiat after removing the thing that earned it.
 *
 * ── The record ─────────────────────────────────────────────────────────
 *
 * 1,130 -> 1,057 resolved trades, net expectancy 0.153% -> 0.097%, profit
 * factor 1.072 -> 1.045. Block-bootstrapped over 6-day blocks (185 blocks)
 * the SE on the new expectancy is 0.356pp, so it sits t=+0.27 from zero and
 * the 0.056pp drop is at most 0.11 SE. Neither number is distinguishable
 * from zero and neither is evidence about this change.
 *
 * One honest note on that SE: 6.0.0's entry recorded 0.31pp for the same
 * data where this pass computes 0.343pp, a bootstrap-settings difference,
 * not a data one. Both are ~2.07x the naive sd/sqrt(n), which is the number
 * that matters.
 *
 * 8.0.0: the layer-conflict veto in tradeRecommendation.ts now requires the
 * opposing thesis to clear REGIME_TREND_CONVICTION (7) before it refuses a
 * trade. Below that bar the conflict is written into the recommendation as a
 * caveat and the trade proceeds. Measurements: scripts/audit/thesisVeto.ts.
 *
 * ── This does NOT make the gate symmetric, and nothing here can ─────────
 *
 * 7.0.0's entry ends by promising the asymmetry would be fixed in
 * tradeRecommendation.ts. That promise was half wrong, and the half that was
 * wrong is the more important half.
 *
 * The veto RULE was always symmetric — `thesis.dominant !== direction`, no
 * side named. It fired on 69.8% of long setups (263/377) and 1.1% of shorts
 * (19/1,793) because of the two layers' MARGINAL distributions, not because
 * of anything in the rule. The bias verdict is bearish on 61.9% of replayed
 * days and bullish on 13.0%; the thesis leans bearish most of the time for
 * the reason 7.0.0 gives. Two layers that both lean the same way agree on
 * shorts and collide on longs, and a symmetric rule applied to lopsided
 * inputs fires lopsidedly. That is arithmetic.
 *
 * So a side-aware correction here — a laxer bar for longs, a stricter one for
 * shorts — would install a second bias to cancel the first and leave both in
 * place. That is the same "two wrongs" 7.0.0 refused when it declined to keep
 * an ungraded input in the thesis as a counterweight. Declined again.
 *
 * ── What was actually broken: `dominant` has no deadband ────────────────
 *
 * `thesis.dominant` is `bullWeight > bearWeight`, strict inequality. The
 * thinnest lean refused a trade exactly as hard as a strong one. The veto's
 * own comment justified itself as the two layers being in "open
 * disagreement," and the honest reading of that phrase is that the opposing
 * thesis clears the bar at which the thesis calls ITSELF directional. It
 * publishes that bar already: REGIME_TREND_CONVICTION, the Trending/Leaning
 * boundary. It is now exported and both consumers read the one number.
 *
 * Conviction on the 282 veto days: 2 -> 122 (43.3%), 4 -> 32 (11.3%),
 * 6 -> 128 (45.4%), >=7 -> 0. Regime label on those days: "Leaning Bearish"
 * 146, "Squeeze Setup — Longs Exposed" 72, "Consolidation" 57, "Leaning
 * Bullish" 7. Fifty-seven refusals came from a thesis whose own label says
 * there is no setup in either direction.
 *
 * The threshold is chosen SEMANTICALLY — it is the existing published
 * boundary and it matches the veto's stated justification. The sensitivity
 * scan in thesisVeto.ts is labelled as a check, not a selection procedure,
 * because picking the bar off the outcome table is how you fit noise.
 *
 * ── The veto bought nothing measurable ──────────────────────────────────
 *
 * Signed forward return, vetoed vs allowed, paired block bootstrap over the
 * date axis (10-day blocks, 2,000 draws, BTC and ETH drawn together):
 *
 *   long side    t = -0.19 / +1.09 / +1.22   at 1d / 3d / 7d
 *   short side   t = -0.92 / +0.01 / +0.41
 *
 * The sign is not even stable across horizons. A note on why the bootstrap is
 * paired: vetoed and allowed are complementary subsets of the SAME dates, so
 * they are not independent and their SEs cannot be combined in quadrature.
 * The first pass did exactly that and reported bearish-1d at t=-4.09. Forming
 * the difference inside each replicate gives t=-0.92. That error would have
 * published a significant defence of a veto that has none.
 *
 * ── HONEST DISCLOSURE: the shipped bar fires zero times here ────────────
 *
 * At REGIME_TREND_CONVICTION the veto never fires in the replay — all 282
 * blocks are released. So this change is, in the replay, indistinguishable
 * from deleting the veto, and the replay cannot tell you whether the retained
 * gate is worth anything. It is retained on the semantic argument, not on
 * evidence: live has seven directional sources against the replay's four and
 * reaches Trending, per 7.0.0's note on not reconciling the two.
 *
 * ── Replay diff, 7.0.0 -> 8.0.0, same 2,896 days ────────────────────────
 *
 * bias fields changed on 0 days. `action` changed on 282, entry/stop/target
 * on 143.
 *
 *   no-trade -> enter-long   141      no-trade -> wait-long   122
 *   no-trade -> wait-short    17      no-trade -> enter-short   2
 *
 *   enter-long    98 -> 239     enter-short  959 -> 961
 *   no-trade    1008 -> 726
 *
 * ── The record improved and that is NOT the evidence ────────────────────
 *
 * n 1,057 -> 1,200, expectancy 0.097% -> 0.324%, profit factor 1.045 ->
 * 1.155. Overlap-corrected over 6-day blocks (4,000 draws):
 *
 *   all     n=1,200  exp  0.324%  blockSE 0.365  (137 blocks)  t = +0.89
 *   long    n=  239  exp  2.141%  blockSE 0.751  ( 32 blocks)  t = +2.85
 *   short   n=  961  exp -0.128%  blockSE 0.408  (106 blocks)  t = -0.31
 *
 * The aggregate blockSE is 2.21x the naive sd/sqrt(n). t=+0.89 is not
 * distinguishable from zero, so the tripled expectancy is not evidence.
 *
 * The long leg's t=+2.85 is in-sample and the window is a crypto bull market.
 * Drift control: unconditional 7d return is 0.537% across all days, 2.672% on
 * long-entry days and 0.434% on short-entry days, mean hold 118h. Entry
 * selection is doing something, but a long book in this window earns most of
 * that from the market.
 *
 * ── What the veto was actually filtering ────────────────────────────────
 *
 * The 141 released long trades returned 1.969% on average, 54.6% win rate.
 * The 98 longs the veto already allowed returned 2.389%, 68.4%. Difference
 * 0.419pp, blockSE 0.862, t = 0.49 over 19 blocks. The veto was not screening
 * out losers; it was screening out slightly-below-average winners, and the
 * claim that it selected better ones does not survive its own standard error.
 *
 * ── The finding worth more than this change ─────────────────────────────
 *
 * The short book is 961 trades at -0.128% expectancy, profit factor 0.945. It
 * is the unprofitable leg, and the veto exempted it almost entirely (1.1%)
 * while blocking 69.8% of the profitable one. Whatever the gate was doing, it
 * was doing it exactly backwards. That is a separate investigation into why
 * the engine takes ten times as many shorts as longs and loses money on them;
 * it is not fixable in the veto and is not attempted here.
 *
 * 9.0.0: funding's direction convention was non-monotone, and the half of it
 * that was documented had essentially never run.
 *
 * `fundingBandVerdict` faded the outer bands and TRENDED the middle two:
 * mildly positive funding read bullish, heavily positive read bearish, with the
 * flip at +0.15%/8h. Its own doc comment described only the fade half —
 * "crowded longs are BEARISH evidence, not doubly bullish" — so the declared
 * convention and the shipped behaviour were opposites everywhere the data
 * actually lives. Band frequencies over the same 2,896 days:
 *
 *   Crowded Longs  (> +0.15%/8h)      0 days   <- the documented fade branch
 *   Longs Paying   (+0.04..+0.15)    30 days   <- 100% of positive-side output
 *   Neutral        (-0.04..+0.04) 2,863 days
 *   Shorts Paying  (-0.15..-0.04)     2 days
 *   Extreme Shorts (< -0.15%/8h)      1 day
 *
 * Fade now applies at every magnitude, in ONE place: marketThesis.ts had
 * hand-copied the same five-way label chain, so the wrong mapping had to be
 * corrected in two engines — the defect shape 6.0.0 and 7.0.0 were both about.
 * It now calls `fundingBandVerdict`. FUNDING_BANDS' two middle labels were
 * "Bullish"/"Bearish" and are now "Longs Paying"/"Shorts Paying": a band
 * labelled "Bullish" is most of why a bullish verdict on mildly positive
 * funding never looked wrong.
 *
 * Fade won on coherence, not on returns. squeezeRisk, marketThesis's own
 * framing and FUNDING_BANDS' "Crowded Longs" description all fade, and the two
 * conventions fighting between 0.005% and 0.15%/8h is exactly why funding and
 * squeezeRisk disagreed on 30 of the 30 replayed days where both spoke. The
 * outcome evidence is consistent and NOT significant: in the Longs Paying band
 * (n=30, ~15 independent dates) price fell 66.7% of the time at 24h and the
 * shipped trend reading won 33.3%, mean -0.359%. At n_eff ~15 that is p ~ 0.3.
 * Tiebreak, not case.
 *
 * ── The band EDGES are still wrong, and it is NOT a replay artifact ─────
 *
 * 7.0.0's entry explains funding's 2,863-day neutrality as FUNDING_BANDS being
 * "calibrated for the live OI-weighted multi-venue composite" while the replay
 * has single-venue Binance. Checked against the recorded live series rather
 * than accepted: 87 live multi-venue readings across 11 assets have median
 * 0.0055%/8h and max 0.0100%/8h. The replay's Binance series has median
 * 0.0058%. Same scale. Not one live reading reaches the +/-0.04% band edge.
 *
 * So funding sits neutral ~99% of the time in production too, while holding the
 * largest weight in METRIC_WEIGHTS. The live sample is thin (~1 day of polling,
 * one calm regime) and cannot prove the edges are never reached; the four-year
 * replay puts +/-0.04% at ~p99 and +/-0.15% past the maximum, which is the
 * stronger evidence. Recalibrating the edges — percentile-based, as
 * computeFundingPercentile and computeSqueezeRisk's own crowding score already
 * are — would move funding from speaking on 1.1% of days to most of them at
 * weight 0.17. That is a calibration decision with a far larger blast radius
 * than this one and it needs its own measurement. Deliberately not bundled.
 *
 * ── The measured delta, 8.0.0 vs 9.0.0 over the same 2,896 days ────────
 *
 *   funding verdict      32 changed (30 bullish->bearish, 2 bearish->bullish)
 *   biasScore            26 changed, mean |delta| 0.009, max |delta| 2
 *   biasVerdict           0 changed
 *   action                0 changed
 *   thesisRegime         10 changed
 *
 * The bump is for the evaluator verdict and the regime classification, not for
 * the headline: the composite is category-weighted and funding is one voter
 * inside Positioning, so 32 flips move the score by at most 2 points and never
 * across a verdict boundary. Nothing the engine would have DONE changed.
 *
 * A measurement note, because the first attempt at this table was wrong: the
 * 8.0.0 baseline had to be regenerated from a stashed tree. The results.json
 * sitting on disk had been produced at 7.0.0, and comparing against it credited
 * this change with 282 action changes and 141 released longs that belong
 * entirely to 8.0.0's veto fix. A stale baseline manufactures a delta that
 * reads exactly like a real one.
 *
 * ── "Trending Bearish" is reachable again: 0 -> 8 days ─────────────────
 *
 * The consequence worth reading twice. 7.0.0 recorded that Trending became
 * unreachable in the replay (Trending Bearish 641 -> 0) once technicals stopped
 * contributing to participation, and ended with an instruction: "DO NOT
 * reconcile the two by lowering REGIME_TREND_CONVICTION against the replay's
 * distribution; that would restore the label by fiat after removing the thing
 * that earned it."
 *
 * The bar is untouched. What changed is that funding and squeezeRisk no longer
 * fight: when both speak they now point the same way, so AGREEMENT rises on
 * those days and conviction clears 7 on its own. Eight days, all bearish, seven
 * of them from "Leaning Bullish" — which is the tell that they were being held
 * down by the manufactured split rather than by genuine two-sided evidence.
 * Restored by fixing the input, not by moving the bar, which is the distinction
 * 7.0.0 asked for.
 *
 * ── squeezeRisk's 0.005%/8h cutoff is NOT changed, and is not the bug ───
 *
 * The two thresholds differ 8x (0.005% vs 0.04%) and that is defensible now
 * that the signs agree: they answer different questions. squeezeRisk's is a
 * which-side-is-exposed pointer already gated by its own score >= 40, so a
 * loose bar is harmless there. funding's is its own directional claim and needs
 * its own extremity bar. Raising squeezeRisk's to 0.04% would also make its
 * side fall back to longShortRatio on ~98% of days, collapsing it into the
 * ratio-only read that 5.0.0 retired longShort for being — and destroying the
 * stated reason squeezeRisk was kept over it.
 *
 * 9.1.0: every score now finds its neutral point from its own history instead
 * of assuming 50 (src/lib/signals/scorePivots.ts). This is the investigation
 * 8.0.0's last paragraph asked for, and it is a CALIBRATION FIX. Read the
 * disclosure section before quoting any number from it.
 *
 * ── The defect ──────────────────────────────────────────────────────────
 *
 * `verdictFromScore` calls <=44 bearish and >=56 bullish. Those thresholds
 * assume the score is centred on 50. It is not, and never was:
 *
 *   scope             median score (2,896 replayed asset-days)
 *   composite              41        73-82% of days below 50
 *   positioning            33 BTC / 32 ETH   81-94% below 50
 *
 * The arithmetic is in `combineCategoryScores`: `((c.score - 50) / 50) * w`
 * hardcodes 50 as each category's neutral point, so positioning's typical 33
 * contributes a permanent -0.34 bearish pull on an ordinary day. Nothing was
 * bearish about that day. The scoring function simply does not centre there.
 *
 * The consequence is not subtle. 61.9% of all replayed days shipped a bearish
 * verdict, and those 1,793 days preceded a mean 7-day return of +0.326% — a
 * RISE. The verdict was not weak, it was pointing the wrong way, and it did so
 * on the majority of days the site was up.
 *
 * ── The fix, and why it translates rather than moving the threshold ─────
 *
 * A point-in-time expanding median of each scope's own prior history becomes
 * that scope's neutral point; the score is translated so that pivot lands on
 * 50. The threshold stays at 44/56.
 *
 * Moving the threshold instead would have been less code and worse. The score
 * is published — it appears on the dashboard, in the API, in every AI summary
 * — and "38, which is neutral" is not something a user can be asked to hold in
 * their head. Translation keeps ONE meaning of 50 across the whole product.
 *
 * Expanding, not rolling: the pivot describes the ENGINE, whose distribution
 * is fixed for as long as ENGINE_VERSION is, and it needs no fitted window
 * length. pivotEffect.ts prints the window sensitivity as a check and says in
 * its own header that reading a length off that table would be selecting a
 * constant from an outcome table.
 *
 * ── Two design defects my own measurement caught ────────────────────────
 *
 * (1) A sigma gate alone was not enough. `leadingDrivers` has median 47 and
 * was already 53.7% below 50 — the one scope that needed nothing — and it
 * cleared a 2-sigma test on a 3-point offset because SE was 0.65. Recentred,
 * it overshoots: pivotEffect §1 still shows the point-in-time arm, which does
 * correct it for part of the walk, at median 59 with 25.3% of days below 50.
 * The correction made the only healthy scope sick. Fixed by PIVOT_MIN_OFFSET, a materiality
 * floor pinned to DIRECTIONAL_THRESHOLD. A pivot must be at least as large as
 * the deadband it shifts, or the correction is below the resolution of the
 * verdict it corrects.
 *
 * (2) A ratchet — once credible, always credible — was tried and removed.
 * leadingDrivers' running median started near 25 (genuinely material), latched
 * the ratchet, then drifted to 47 while the latch kept applying a correction
 * the scope no longer needed. Materiality is a claim about the present, not a
 * qualification a scope keeps. The jitter the ratchet guarded against is
 * bounded (exactly PIVOT_MIN_OFFSET points) and rare.
 *
 * ── What actually ships: one pivot ──────────────────────────────────────
 *
 * After both gates the ONLY surviving pivot is positioning, 33 for BTC and 32
 * for ETH. The composite's own residual offset falls below the floor once
 * positioning is corrected, so it gets nothing and centres itself as a
 * consequence: median 41 -> 53. leadingDrivers gets nothing. The engine is
 * therefore "recentre positioning, let the composite follow".
 *
 * Residual disclosed: 53, not 50. The composite is corrected indirectly, so it
 * lands 3 points high. That is inside the deadband and is not chased.
 *
 * ── HONEST DISCLOSURE: the deployed change buys no separation ───────────
 *
 * Measured POINT-IN-TIME, bullish-minus-bearish 7d separation goes +1.740% ->
 * +3.186% and the paired improvement is +1.445%, SE 0.988, t = 1.46. That
 * number describes an engine that will not run.
 *
 * Live has no history to expand over. It reads the committed artifact, which
 * is the pivot set the walk ENDED on. Replaying against that artifact instead
 * (`--pivots=shipped`) gives separation +1.861% and a deployed improvement of
 * +0.120%, SE 0.793, t = 0.15. Nothing.
 *
 * The whole gap is leadingDrivers. Point-in-time recentred it by a median +19
 * points on 1,878 of 2,896 asset-days, from 2022-09-13 to 2025-04-08, and then
 * it stopped qualifying. That was not cheating — its offset was genuinely
 * large and genuinely knowable at the time. The scope has since re-centred for
 * real (raw median by year: 25, 31, 54.5, 59, 50), so the final artifact
 * correctly excludes it and live will never apply it. The mechanism worked on
 * a disease that has since cured itself. Nothing is recoverable: positioning
 * is the only scope still off-centre, and it is stationary (39, 36, 39, 32, 32
 * by year — never once near 50).
 *
 * ── What IS claimed, and it is the thing 8.0.0 asked for ────────────────
 *
 * Paired panel, 9.0.0 against the shipped artifact, same 2,896 asset-days,
 * 10-day blocks, 4,000 draws, BTC and ETH drawn together. The control is the
 * SAME TREE with `--pivots=off`, not a results.json copied aside — 9.0.0's own
 * entry records what a stale baseline manufactures:
 *
 *   bearish verdict, mean fwd 7d   +0.326% -> -0.890%   d -1.215%  t = -2.76
 *   bullish verdict, mean fwd 7d   +2.066% -> +0.971%   d -1.095%  t = -1.72
 *   share of days called bearish     61.9% ->   25.7%   d -36.2pp  t = -18.5
 *
 * The bearish verdict stops preceding a rise. That is a SIGN fix on the
 * majority verdict, and it is significant. It is also why separation is flat:
 * the bullish leg dilutes by almost exactly as much as the bearish leg gains,
 * so the spread between them barely moves. Both facts are true and both are
 * printed above; quoting the first without the second would be dishonest.
 *
 * This is shipped on correctness, not performance. A verdict that reads
 * "bearish" on 62% of days while those days rise is broken whether or not
 * fixing it improves a t-statistic. §4 of the charter — never output a bare
 * verdict the evidence does not support — is the argument, and the separation
 * statistic declining to endorse it does not change that.
 *
 * ── Replay diff, 9.0.0 -> 9.1.0 (shipped arm), same 2,896 days ──────────
 *
 *   verdict     9.0.0                9.1.0
 *   bullish       377  13.0%          1033  35.7%
 *   neutral       726  25.1%          1119  38.6%
 *   bearish      1793  61.9%           744  25.7%
 *
 *   book        n     expectancy   PF        n     expectancy   PF
 *   long      239       +2.141%   2.734    567       +1.058%   1.598
 *   short     961       -0.128%   0.945    448       +0.628%   1.321
 *
 * The short book stops losing money — 8.0.0's closing question, answered. The
 * book is in-sample and moves for reasons unrelated to verdict quality; it is
 * a consequence of the claim above, not the evidence for it, exactly as 8.0.0
 * said of its own improved record.
 *
 * ── The artifact is frozen, and that is a real limitation ───────────────
 *
 * src/data/scorePivots.json is regenerated only by a full replay, which needs
 * the backtest corpus and COINALYZE_API_KEY. CI has neither, so the artifact
 * does not refresh on its own and live drifts further from point-in-time as
 * time passes. Tolerable today because the one shipped pivot is stationary and
 * estimated on n=1,448 — a month of new days barely moves an expanding median
 * at that n — but it is a standing obligation to re-run the replay, not a
 * solved problem. `pivotsForAsset` refuses an artifact stamped for a different
 * ENGINE_VERSION and the site falls back to a hard 50, so the failure mode is
 * reverting to 9.0.0's behaviour rather than shipping a stale correction.
 *
 * ── Landed on top of 9.0.0, and re-measured rather than rebased ─────────
 *
 * This work was measured against 8.0.0 and was ready to ship as 9.0.0 when
 * the funding-convention change landed first and took that number. Renumbering
 * would not have been enough: `fundingBandVerdict` is a POSITIONING metric,
 * and positioning is the one and only scope this entry recentres, so the
 * artifact would have been a calibration of a superseded engine.
 *
 * Re-run end to end on the merged tree, the pivots are unchanged — 33 BTC,
 * 32 ETH — and every statistic above moved by less than its own SE. That is
 * what 9.0.0's table predicted: 32 funding flips moved the composite on 26 of
 * 2,896 days by at most 2 points and changed no verdict, so the control arm's
 * verdict distribution is identical. The agreement is the check, not a reason
 * to have skipped it.
 *
 * Measurements: scripts/audit/pivotEffect.ts (§6 is the deployed arm, and now
 * prints the per-leg claim and the deployed book — three numbers this entry
 * previously quoted from an out-of-band computation, one of which was wrong:
 * the long book is 567 at +1.058%, not 581 at +1.098%).
 *
 * 9.2.0: the replay now ranks funding the way the deployed site ranks it. This
 * is a MEASUREMENT-VALIDITY fix, not a performance change, and the numbers
 * below say so — the point is that every squeezeRisk statistic the replay has
 * ever published described an engine the site does not run.
 *
 * ── Two ways the replay's percentile was not production's ───────────────
 *
 * `computeFundingPercentile(current, history)` is one function with two
 * callers. The live aggregator feeds it `readHistory(asset)`; the replay fed
 * it every prior funding print since 2022. Same code, different question:
 *
 *   dimension        replay (before)        production
 *   window           expanding, ~4 years    rolling 30 days (readHistory)
 *   venue            Binance only           OI-weighted multi-venue
 *   points in window thousands              tens
 *   ties at 0.01%    26.8% of all rows      none observed (102/109 distinct)
 *
 * This is not a footnote about a minor input. `computeSqueezeRisk` weights the
 * funding-crowding term at 0.35, its LARGEST component, and that term is
 * `|fundingPercentile - 50| * 2`. squeezeRisk carries 0.14 of METRIC_WEIGHTS.
 * A percentile the site never computes was driving the biggest share of a
 * voter the site does ship.
 *
 * ── The tie rule was independently wrong ────────────────────────────────
 *
 * `values.filter(v => v <= current).length` counts a value equal to the
 * current one as below it. Harmless on a continuous series; not here. Binance
 * pins funding at its 0.010000%/8h baseline whenever the premium is ~0, and
 * that single value is 777 of 2,896 replayed rows — 26.8%. Under `<=` an
 * utterly ordinary day ranked at a median p94, so `|94 - 50| * 2` handed
 * crowding an 88/100 on the most boring funding print the exchange emits.
 * Measured: modal-funding days scored squeezeRisk 72.5 and read bearish 82.6%
 * of the time, against 59.4 and 75.3% elsewhere.
 *
 * Fixed to the midrank convention, `(below + 0.5*equal)/n`, which is a no-op
 * when there are no ties — and production has none, so this changes the replay
 * and leaves the live number alone. `oiPercentileFromHistory` deliberately
 * keeps `<=`: OI is a continuous USD sum with no point mass to mis-rank.
 *
 * ── What moved, over the same 2,896 asset-days, --pivots=off both arms ──
 *
 *   fundingPercentile   before: p25 24  p50 43  p75 91     <- not a percentile
 *                       after:  p25 24  p50 50  p75 75
 *                       identical on 70/2,896 rows; median |shift| 15 points
 *   squeezeScore        p50 64 -> 61, mean 62.9 -> 60.6
 *   biasScore           p25/p50/p75 34/41/49 -> UNCHANGED
 *   verdict             70 flips of 2,896 (2.4%): 31 bearish->neutral,
 *                       17 neutral->bearish, 13 neutral->bullish, 9 the other way
 *
 * ── It did not improve the record, and was not supposed to ──────────────
 *
 * Verdict-directional forward 7d over all 2,892 labelled days: +6.793% before,
 * +6.543% after, against an SE of 12.4. On the 70 flipped days alone the
 * paired delta is -10.34% at SE 72.67, t -0.14. There is no outcome evidence
 * either way and there was never going to be at n=70.
 *
 * The justification is not P&L. It is that the replay is the only instrument
 * this project has for judging the engine, and an instrument calibrated to a
 * different engine answers a question nobody asked. Quoting the -10.34% as a
 * cost would be the mirror of quoting a +10% as a gain: both are one SE of
 * noise wearing a sign.
 *
 * ── Still not matched, stated plainly ───────────────────────────────────
 *
 * Window length now agrees; point DENSITY does not. The replay sees ~90
 * 8-hourly Binance prints inside its 30 days, production tens of multi-venue
 * readings. And the venue construction still differs. So the replay's
 * percentile is now the same STATISTIC as production's over the same window,
 * not the same number. The 30-day bound is imported from
 * `HISTORY_RETENTION_MS` rather than restated, so the two cannot drift.
 *
 * ── The 9.1.0 pivots were re-measured, not carried over ─────────────────
 *
 * positioning is the scope 9.1.0 recentres and funding is a positioning
 * metric, so the shipped artifact was a calibration of the superseded engine
 * — the same trap 9.1.0's own last section describes, and the reason
 * `pivotsForAsset` refuses a version-mismatched artifact.
 *
 * Regenerated under 9.2.0 from all three arms and re-measured with
 * scripts/audit/pivotEffect.ts. The pivots barely moved — positioning 33 -> 32
 * BTC, 32 -> 32 ETH, composite still below PIVOT_MIN_OFFSET in both — and
 * 9.1.0's claim reproduces inside its own SE on every leg:
 *
 *                                 9.1.0 as documented      re-measured under 9.2.0
 *   bearish verdict, fwd 7d   +0.326% -> -0.890%  t -2.76   +0.333% -> -0.945%  t -2.84
 *   bullish verdict, fwd 7d   +2.066% -> +0.971%  t -1.72   +2.050% -> +0.924%  t -1.87
 *   share of days bearish       61.9% ->   25.7%  t -18.5     61.4% ->   25.3%  t -18.38
 *
 * That agreement is the CHECK, not a reason the re-run could have been
 * skipped. 9.1.0's own entry records the alternative: renumbering without
 * re-measuring ships a calibration of an engine that no longer exists.
 *
 * ── The band recalibration this rank was blocking ───────────────────────
 *
 * b9c4d47 measured 14 candidate FUNDING_BANDS specifications and declined all
 * of them. That measurement ran on the OLD rank, so it was re-run here. The
 * null survived: best standalone |t| 1.14, best conditional t 1.90 as the
 * argmax of fourteen correlated specifications, sign still unstable across
 * rank constructions and across BTC/ETH. FUNDING_BANDS and METRIC_WEIGHTS
 * are unchanged by this entry.
 *
 * Measurements: scripts/audit/fundingBands.ts §3 and §8, scripts/audit/pivotEffect.ts §6.
 */
/*
 * Re-exported, not declared. The value lives in src/lib/signals/engineVersion.ts
 * because the live site has to check the scorePivots calibration against it and
 * must not import a backtest script to do so. Bump it there; document it here.
 */
import { ENGINE_VERSION } from "../../src/lib/signals/engineVersion";
export { ENGINE_VERSION };

/**
 * Bump when the meaning or shape of the replayed FEATURES changes — a new
 * input series, a different candle window, a changed rollup. Separate from
 * the engine version because the same engine over different inputs is a
 * different experiment.
 *
 * 2.0.0: Phase 3 added 4H candles (rolled up from hourly) and support/
 * resistance zones to the replay, and capped both to the live 300-bar
 * window rather than unbounded history.
 */
export const FEATURE_VERSION = "2.0.0";

export interface BacktestProvenance {
  engineVersion: string;
  featureVersion: string;
  generatedAt: number;
  assets: string[];
  coverageStart: string | null;
  coverageEnd: string | null;
  evaluatedDays: number;
  /** Longest a replayed trade is held before closing at market, in hours. */
  maxHoldHours: number;
  costConfig: CostConfig;
  /** Named so a reader knows which frictions are measured and which are assumed. */
  costNotes: string;
  dataSources: string[];
  /** Decision inputs with no historical source, null throughout the replay. */
  unavailableInputs: string[];
}

export function buildProvenance(params: {
  assets: string[];
  coverageStart: string | null;
  coverageEnd: string | null;
  evaluatedDays: number;
  maxHoldHours: number;
  costConfig?: CostConfig;
}): BacktestProvenance {
  return {
    engineVersion: ENGINE_VERSION,
    featureVersion: FEATURE_VERSION,
    generatedAt: Date.now(),
    assets: params.assets,
    coverageStart: params.coverageStart,
    coverageEnd: params.coverageEnd,
    evaluatedDays: params.evaluatedDays,
    maxHoldHours: params.maxHoldHours,
    costConfig: params.costConfig ?? DEFAULT_COST_CONFIG,
    costNotes:
      "Funding is the real historical Binance 8-hourly settlement series. Fees and slippage are declared assumptions, not measurements — there is no historical order-book depth in this dataset to derive slippage from.",
    dataSources: [
      "Binance Vision archive — hourly futures/spot klines, 8-hourly funding",
      "Coinalyze — open interest, long/short ratio (rolling retention window)",
      "SoSoValue — spot ETF net flows (BTC/ETH only, from 2025-05-21)",
      "alternative.me — Fear & Greed",
      "DefiLlama — total stablecoin supply",
      "FRED — NFCI, T10Y2Y, RRP, TGA, EFFR",
    ],
    unavailableInputs: [
      "orderFlow (OKX rubik retains ~4 days)",
      "deribitOptions (no public historical archive)",
      "spotCvd (taker-buy volume not archived)",
      "exchangeFlow (on-chain balances not archived)",
      "liquidations (not fetched historically)",
      "coinbasePremium (no historical source)",
      "sectorBreadth (live-only)",
      "hyperliquidConfirm (point-in-time order book)",
    ],
  };
}
