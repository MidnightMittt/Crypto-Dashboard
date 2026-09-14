/**
 * INTERRUPT OR ROW — the trading session's amended declaration, verbatim.
 *
 * The site's first proposal (third-party species, proxies, or
 * filer != registrant) tested clean against 224 live hits and still
 * missed the one event the whole watch was built for: a financing
 * announcement arrives as a SELF-FILED 8-K on the company's own name.
 * The amendment fixes it with a declared book-or-thesis list on which
 * EVERY species interrupts — on ten names the volume is tractable and
 * the cost asymmetry is severe.
 *
 * Nothing here scores. The register carries three separate rejections of
 * methods that scored importance; species and filer are facts, "how
 * important is this filing" is not one. The classifier is three
 * categorical rules and a fallthrough.
 */

export const PROXY_FAMILY = [
  "DEF 14A", "DEFC14A", "DEFM14A", "DEFN14A", "DEFR14A", "DEFA14A",
  "PRE 14A", "PREC14A", "PREN14A", "PRER14A", "PRRN14A", "PREM14A",
  "DFAN14A", "PX14A6G",
];

export interface FilingHitInput {
  symbol: string;
  form: string;
  filer: string | null;
  registrant: string;
}

export type FilingClass =
  | { level: "interrupt"; rule: "book-or-thesis name, any species" }
  | { level: "interrupt"; rule: "filer is not the registrant" }
  | { level: "interrupt"; rule: "proxy-family species" }
  | { level: "row"; rule: "none of the declared interrupt conditions" };

export function classifyFiling(hit: FilingHitInput, bookOrThesis: readonly string[]): FilingClass {
  if (bookOrThesis.includes(hit.symbol)) {
    return { level: "interrupt", rule: "book-or-thesis name, any species" };
  }
  /*
   * Filer comparison is deliberately loose on case and punctuation —
   * EDGAR headers write "NEUGEBAUER TOBY R" while the registrant field
   * reads "Fermi Inc." — but a null filer does NOT interrupt: a failed
   * header fetch is missing data, and missing data escalating to an
   * interrupt would page a human on every transport hiccup.
   */
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (hit.filer !== null && norm(hit.filer) !== norm(hit.registrant)) {
    return { level: "interrupt", rule: "filer is not the registrant" };
  }
  if (PROXY_FAMILY.includes(hit.form)) {
    return { level: "interrupt", rule: "proxy-family species" };
  }
  return { level: "row", rule: "none of the declared interrupt conditions" };
}
