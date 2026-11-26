// Wallet connection and trading for HyperSpace.
//
// Flow (the standard Hyperliquid "API wallet" pattern):
//   1. Connect a browser wallet (read its address).
//   2. Enable trading: the main wallet signs `approveAgent` for a key generated in this browser,
//      and, when a builder address is configured, `approveBuilderFee`. Both are one-time signatures.
//   3. Orders and cancels are signed locally by the agent key, so there is no wallet pop-up per order.
// An agent key can place and cancel orders but cannot withdraw or transfer funds.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createWalletClient, custom, getAddress, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { IS_TESTNET, NETWORK } from '../hl/network';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BP } from '../hl/order';
import { listWallets, onWalletsChanged, type WalletInfo } from './eip1193';

export const AGENT_NAME = 'HyperSpace';
const LAST_WALLET = 'hs.lastWallet';
const agentKeyStorage = (user: string) => `hs.agent.${NETWORK}.${user.toLowerCase()}`;

const transport = new HttpTransport({ isTestnet: IS_TESTNET });
export const infoClient = new InfoClient({ transport });

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage blocked: the agent lives only for this page load */
    }
  },
};

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } };
}

export type OrderResult = { kind: 'resting'; oid: number } | { kind: 'filled'; oid: number; avgPx: string; totalSz: string } | { kind: 'error'; message: string };

interface WalletState {
  wallets: WalletInfo[];
  address: `0x${string}` | null;
  walletName: string | null;
  connecting: boolean;
  error: string | null;
  /** Agent key approved on Hyperliquid and present in this browser. */
  agentReady: boolean;
  /** Builder fee approved at or above our rate (true when no builder is configured). */
  builderReady: boolean;
  checking: boolean;
  enabling: boolean;
  tradingReady: boolean;
  connect: (w: WalletInfo) => Promise<void>;
  disconnect: () => void;
  enableTrading: () => Promise<void>;
  placeOrder: (order: OrderWire) => Promise<OrderResult>;
  cancelOrder: (asset: number, oid: number) => Promise<void>;
  /** EIP-191 personal_sign with the connected main wallet. */
  signMessage: (message: string) => Promise<`0x${string}`>;
  /** Bumped after every order or cancel so account views refetch. */
  revision: number;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

/** Human message from SDK and wallet errors. */
export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001) return 'Request rejected in your wallet.';
  return err?.shortMessage ?? err?.message ?? String(e);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<WalletInfo[]>(() => listWallets());
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState<`0x${string}` | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const [builderReady, setBuilderReady] = useState(!BUILDER_ADDRESS);
  const [checking, setChecking] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => onWalletsChanged(() => setWallets(listWallets())), []);

  const walletClient: WalletClient | null = useMemo(
    () => (wallet && address ? createWalletClient({ account: address, transport: custom(wallet.provider) }) : null),
    [wallet, address],
  );

  const agentExchange = useMemo(
    () => (agentKey ? new ExchangeClient({ transport, wallet: privateKeyToAccount(agentKey) }) : null),
    [agentKey],
  );

  const connect = useCallback(async (w: WalletInfo, silent = false) => {
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as string[];
      if (!accounts?.length) {
        if (!silent) setError('No account was shared by the wallet.');
        return;
      }
      setWallet(w);
      setAddress(getAddress(accounts[0]));
      store.set(LAST_WALLET, w.uuid);
    } catch (e) {
      if (!silent) setError(errorText(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  // Reconnect silently to the wallet used last time, if it still shares an account.
  useEffect(() => {
    if (address) return;
    const last = store.get(LAST_WALLET);
    const w = wallets.find((x) => x.uuid === last);
    if (w) void connect(w, true);
  }, [wallets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow account switches inside the wallet.
  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (accs: string[]) => setAddress(accs?.length ? getAddress(accs[0]) : null);
    p.on('accountsChanged', onAccounts);
    return () => p.removeListener?.('accountsChanged', onAccounts);
  }, [wallet]);

  const disconnect = useCallback(() => {
    store.set(LAST_WALLET, null);
    setWallet(null);
    setAddress(null);
  }, []);

  // Check whether this browser's agent key and the builder fee are approved for the connected account.
  const refreshTrading = useCallback(async (user: `0x${string}`) => {
    setChecking(true);
    try {
      const key = store.get(agentKeyStorage(user)) as `0x${string}` | null;
      setAgentKey(key);
      let ok = false;
      if (key) {
        const agentAddr = privateKeyToAccount(key).address.toLowerCase();
        const agents = await infoClient.extraAgents({ user });
        ok = agents.some((a) => a.address.toLowerCase() === agentAddr && (a.validUntil === null || a.validUntil > Date.now()));
      }
      setAgentReady(ok);
      if (BUILDER_ADDRESS) {
        const max = await infoClient.maxBuilderFee({ user, builder: BUILDER_ADDRESS as `0x${string}` });
        setBuilderReady(max >= BUILDER_FEE_TENTHS_BP);
      } else {
        setBuilderReady(true);
      }
    } catch (e) {
      setError(`Could not check trading status: ${errorText(e)}`);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    setAgentReady(false);
    setAgentKey(null);
    if (address) void refreshTrading(address);
  }, [address, refreshTrading]);

  const enableTrading = useCallback(async () => {
    if (!walletClient || !address) return;
    setEnabling(true);
    setError(null);
    try {
      const main = new ExchangeClient({ transport, wallet: walletClient as never });
      if (!agentReady) {
        const key = generatePrivateKey();
        await main.approveAgent({ agentAddress: privateKeyToAccount(key).address, agentName: AGENT_NAME });
        store.set(agentKeyStorage(address), key);
        setAgentKey(key);
      }
      if (BUILDER_ADDRESS && !builderReady) {
        await main.approveBuilderFee({
          builder: BUILDER_ADDRESS as `0x${string}`,
          maxFeeRate: `${BUILDER_FEE_TENTHS_BP / 1000}%`,
        });
      }
      await refreshTrading(address);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setEnabling(false);
    }
  }, [walletClient, address, agentReady, builderReady, refreshTrading]);

  const placeOrder = useCallback(
    async (order: OrderWire): Promise<OrderResult> => {
      if (!agentExchange) return { kind: 'error', message: 'Enable trading first.' };
      try {
        const res = await agentExchange.order({
          orders: [order],
          grouping: 'na',
          ...(BUILDER_ADDRESS ? { builder: { b: BUILDER_ADDRESS as `0x${string}`, f: BUILDER_FEE_TENTHS_BP } } : {}),
        });
        const st = res.response.data.statuses[0] as Record<string, any>;
        if (st && 'resting' in st) return { kind: 'resting', oid: st.resting.oid };
        if (st && 'filled' in st) return { kind: 'filled', oid: st.filled.oid, avgPx: st.filled.avgPx, totalSz: st.filled.totalSz };
        return { kind: 'error', message: st?.error ?? 'Unexpected response from Hyperliquid.' };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange],
  );

  const cancelOrder = useCallback(
    async (asset: number, oid: number) => {
      if (!agentExchange) throw new Error('Enable trading first.');
      try {
        await agentExchange.cancel({ cancels: [{ a: asset, o: oid }] });
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange],
  );

  const signMessage = useCallback(
    async (message: string) => {
      if (!walletClient || !address) throw new Error('Connect a wallet first.');
      return walletClient.signMessage({ account: address, message });
    },
    [walletClient, address],
  );

  const value: WalletState = {
    wallets,
    address,
    walletName: wallet?.name ?? null,
    connecting,
    error,
    agentReady,
    builderReady,
    checking,
    enabling,
    tradingReady: !!address && agentReady && builderReady && !!agentKey,
    connect: (w) => connect(w),
    disconnect,
    enableTrading,
    placeOrder,
    cancelOrder,
    signMessage,
    revision,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
