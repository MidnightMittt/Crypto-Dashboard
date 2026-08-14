import * as React from "react";

/**
 * A fold whose contents are ALWAYS in the document.
 *
 * Deliberately not `Collapsible`, which mounts its children only while open —
 * correct there (24 exchange cards each running a countdown timer), wrong
 * here. This wraps the research page's depth, and the promise that depth is
 * layered rather than hidden is only true if the words are actually present:
 * find-in-page has to hit them, a reader-mode or print view has to include
 * them, and a crawler has to see them. `{open && children}` would quietly
 * turn "moved underneath the decision" into "deleted below the fold".
 *
 * Native `<details>` gives all of that with no JavaScript and no client
 * boundary, so this stays a server component and costs nothing to render.
 */
export function FoldedSection({
  title,
  summary,
  children,
}: {
  title: string;
  /** What is inside, so folding never conceals what was folded. */
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      {/* The blurb lives INSIDE the summary, so it is readable while closed.
          A fold that only describes its contents once opened tells you what
          you have already found. */}
      <summary className="cursor-pointer list-none rounded-md border border-hairline bg-void/30 px-4 py-3 hover:border-ink-faint/30 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted group-hover:text-ink">
            {title}
          </h2>
          <svg
            className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-180"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="ml-auto text-[11px] text-ink-faint">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </div>
        {summary && <p className="mt-1.5 max-w-[80ch] text-[11px] leading-relaxed text-ink-faint">{summary}</p>}
      </summary>
      <div className="flex flex-col gap-5 pt-5">{children}</div>
    </details>
  );
}
