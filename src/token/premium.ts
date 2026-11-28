// HyperSpace premium, paid in the HYPERSPACE token. Buying stays switched off until the token
// launches: nothing here moves funds. Tokens spent on premium are meant to be burned, not paid
// to holders (see the trader wishlist's "Skip" list for why there is no revenue share).

export const TOKEN_SYMBOL = 'HYPERSPACE';

/** Turns on only after launch, with a real payment flow behind it. */
export const TOKEN_LIVE = false;

export interface Limits {
  alerts: number;
  walletWatch: number;
  savedLayouts: number;
  chartsPerLayout: number;
}

export const FREE: Limits = { alerts: 10, walletWatch: 5, savedLayouts: 3, chartsPerLayout: 4 };
export const PREMIUM: Limits = { alerts: 100, walletWatch: 50, savedLayouts: 25, chartsPerLayout: 4 };

export const PREMIUM_PLAN = {
  pricePer30Days: 500,
  perks: ['100 alerts instead of 10', 'Watch 50 wallets instead of 5', '25 saved chart layouts instead of 3', 'Paid indicators from the Market'],
  note: `Paid in ${TOKEN_SYMBOL}. Tokens spent on premium are burned, so spending reduces supply rather than paying anyone a return.`,
};

/** Premium is not purchasable yet, so everyone is on the free plan. */
export function currentLimits(): Limits {
  return FREE;
}

export function limitMessage(what: keyof Limits) {
  const l = currentLimits();
  const label = { alerts: 'alerts', walletWatch: 'watched wallets', savedLayouts: 'saved layouts', chartsPerLayout: 'charts per layout' }[what];
  return `The free plan allows ${l[what]} ${label}. Premium (${PREMIUM[what]}, paid in ${TOKEN_SYMBOL}) opens when the token launches.`;
}
