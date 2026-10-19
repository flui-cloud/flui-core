export interface QuotaWindow {
  pace(): Promise<void>;
  add(tokens: number): void;
}

/** Holds each turn back until the tokens spent in the last 60 s fall under the budget. */
export function quotaWindow(tpmBudget: number): QuotaWindow {
  const spent: { at: number; tokens: number }[] = [];
  return {
    async pace() {
      for (;;) {
        const now = Date.now();
        while (spent.length && now - spent[0].at > 60_000) spent.shift();
        const used = spent.reduce((n, w) => n + w.tokens, 0);
        if (used < tpmBudget || !spent.length) return;
        await new Promise((r) =>
          setTimeout(r, Math.max(1000, 60_000 - (now - spent[0].at) + 500)),
        );
      }
    },
    add(tokens: number) {
      spent.push({ at: Date.now(), tokens });
    },
  };
}
