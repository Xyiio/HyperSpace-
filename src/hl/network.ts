// Mainnet or testnet, chosen in the header and remembered per browser.
export type Network = 'mainnet' | 'testnet';

const KEY = 'hs.network';

function read(): Network {
  try {
    return localStorage.getItem(KEY) === 'testnet' ? 'testnet' : 'mainnet';
  } catch {
    return 'mainnet';
  }
}

export const NETWORK: Network = read();
export const IS_TESTNET = NETWORK === 'testnet';
export const API_URL = IS_TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';
export const WS_URL = IS_TESTNET ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws';
export const APP_URL = IS_TESTNET ? 'https://app.hyperliquid-testnet.xyz' : 'https://app.hyperliquid.xyz';

/** Switching network reloads the app so every client and stream starts clean. */
export function setNetwork(n: Network) {
  try {
    localStorage.setItem(KEY, n);
  } catch {
    /* private mode: stays on the current network */
  }
  location.reload();
}
