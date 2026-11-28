// Wallet connection and trading for HyperSpace.
//
// Flow (the standard Hyperliquid "API wallet" pattern):
//   1. Connect a browser wallet (read its address).
//   2. Enable trading: the main wallet signs `approveAgent` for a key generated in this browser,
//      and, when a builder address is configured, `approveBuilderFee`. Both are one-time signatures.
//   3. Orders and cancels are signed locally by the agent key, so there is no wallet pop-up per order.
// An agent key can place and cancel orders but cannot withdraw or transfer funds.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createWalletClient, custom, getAddress, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { IS_TESTNET, NETWORK } from '../hl/network';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BP } from '../hl/order';
import { listWallets, onWalletsChanged, type WalletInfo } from './eip1193';
import { fetchLeadingVaults, fetchSubAccounts, type Market } from '../hl/api';
import type { AnyOrderWire, Grouping } from '../hl/orders';
import { hlSocket } from '../hl/ws';
import * as paperEngine from '../paper/engine';
import type { PaperState } from '../paper/engine';

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

export type OrderWire = AnyOrderWire;

export type OrderResult = { kind: 'resting'; oid: number } | { kind: 'filled'; oid: number; avgPx: string; totalSz: string } | { kind: 'error'; message: string };
export type TwapResult = { kind: 'running'; twapId: number } | { kind: 'error'; message: string };
export interface TwapInput {
  a: number;
  b: boolean;
  s: string;
  r: boolean;
  m: number; // minutes, 5 to 1440
  t: boolean; // randomize slice timing
}

/** An account the agent key can trade for: the main wallet, a sub-account, or a vault it leads. */
export interface TradeAccount {
  address: string;
  name: string;
  kind: 'main' | 'sub' | 'vault';
}

const PAPER_KEY = `hs.paper.${NETWORK}`;
const PAPER_ON = 'hs.paperOn';
const tradeAccountKey = (user: string) => `hs.tradeAccount.${NETWORK}.${user.toLowerCase()}`;

function loadPaper(): PaperState {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    const s = raw ? (JSON.parse(raw) as PaperState) : null;
    return s?.v === 1 ? s : paperEngine.newPaper();
  } catch {
    return paperEngine.newPaper();
  }
}

/** Reads the status of each order in an exchange response. */
function statusesOf(res: { response: { data: { statuses: unknown[] } } }): OrderResult[] {
  return (res.response.data.statuses as any[]).map((st): OrderResult => {
    if (st && 'resting' in st) return { kind: 'resting', oid: st.resting.oid };
    if (st && 'filled' in st) return { kind: 'filled', oid: st.filled.oid, avgPx: st.filled.avgPx, totalSz: st.filled.totalSz };
    if (st === 'waitingForFill' || st === 'waitingForTrigger') return { kind: 'resting', oid: 0 };
    return { kind: 'error', message: st?.error ?? 'Unexpected response from Hyperliquid.' };
  });
}

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
  /** Several orders in one signed request (brackets use `normalTpsl`, ladders `na`). */
  placeOrders: (orders: OrderWire[], grouping?: Grouping) => Promise<OrderResult[]>;
  cancelOrder: (asset: number, oid: number) => Promise<void>;
  cancelOrders: (cancels: { a: number; o: number }[]) => Promise<void>;
  /** Replace a resting order (new price or trigger). */
  modifyOrder: (oid: number, order: OrderWire) => Promise<OrderResult>;
  twapOrder: (t: TwapInput) => Promise<TwapResult>;
  twapCancel: (asset: number, twapId: number) => Promise<void>;
  /** Accounts this wallet can trade: main, sub-accounts and vaults it leads. */
  accounts: TradeAccount[];
  /** The account orders go to and the account panel shows (lower-case), or null when not connected. */
  tradeAccount: string | null;
  setTradeAccount: (address: string) => void;
  /** Paper trading: practice on live prices with pretend money. No wallet needed. */
  paper: boolean;
  setPaper: (on: boolean) => void;
  paperState: PaperState;
  resetPaper: () => void;
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

export function WalletProvider({ children, markets }: { children: ReactNode; markets: Market[] }) {
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
  const [accounts, setAccounts] = useState<TradeAccount[]>([]);
  const [tradeAccount, setTradeAccountState] = useState<string | null>(null);
  const [paper, setPaperState] = useState(() => store.get(PAPER_ON) === '1');
  const [paperState, setPaperStateValue] = useState<PaperState>(loadPaper);
  const paperRef = useRef(paperState);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

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

  // Sub-accounts and vaults this wallet leads.
  useEffect(() => {
    setAccounts([]);
    if (!address) {
      setTradeAccountState(null);
      return;
    }
    const main = address.toLowerCase();
    const saved = store.get(tradeAccountKey(main));
    setTradeAccountState(saved ?? main);
    let alive = true;
    Promise.all([fetchSubAccounts(main).catch(() => []), fetchLeadingVaults(main)]).then(([subs, vaults]) => {
      if (!alive) return;
      const list: TradeAccount[] = [
        { address: main, name: 'Main account', kind: 'main' },
        ...subs.map((x) => ({ address: x.subAccountUser.toLowerCase(), name: x.name, kind: 'sub' as const })),
        ...vaults.map((v) => ({ address: v.address.toLowerCase(), name: v.name, kind: 'vault' as const })),
      ];
      setAccounts(list);
      if (saved && !list.some((a) => a.address === saved)) setTradeAccountState(main);
    });
    return () => {
      alive = false;
    };
  }, [address]);

  const setTradeAccount = useCallback(
    (a: string) => {
      if (!address) return;
      store.set(tradeAccountKey(address), a.toLowerCase());
      setTradeAccountState(a.toLowerCase());
      setRevision((r) => r + 1);
    },
    [address],
  );

  // Orders for a sub-account or vault are signed by the same agent with `vaultAddress` set.
  const vaultOpts = useMemo(
    () => (tradeAccount && address && tradeAccount !== address.toLowerCase() ? { vaultAddress: tradeAccount as `0x${string}` } : undefined),
    [tradeAccount, address],
  );

  // ---------- Paper trading ----------
  const savePaper = useCallback((s: PaperState) => {
    paperRef.current = s;
    setPaperStateValue(s);
    try {
      localStorage.setItem(PAPER_KEY, JSON.stringify(s));
    } catch {
      /* not persisted */
    }
  }, []);

  const setPaper = useCallback((on: boolean) => {
    store.set(PAPER_ON, on ? '1' : null);
    setPaperState(on);
    setRevision((r) => r + 1);
  }, []);

  const resetPaper = useCallback(() => savePaper(paperEngine.newPaper()), [savePaper]);

  const coinByAsset = useCallback((a: number) => {
    const m = marketsRef.current.find((x) => x.index === a);
    return m ? { coin: m.name, maxLeverage: m.maxLeverage } : undefined;
  }, []);
  const coinByName = useCallback((c: string) => {
    const m = marketsRef.current.find((x) => x.name === c);
    return m ? { coin: m.name, maxLeverage: m.maxLeverage } : undefined;
  }, []);

  // Live mids drive paper fills while paper mode is on.
  const dexKey = useMemo(() => [...new Set(markets.map((m) => m.dex))].sort().join(','), [markets]);
  useEffect(() => {
    if (!paper) return;
    const dexes = dexKey.split(',');
    const latest: Record<string, number> = {};
    for (const m of marketsRef.current) {
      const mid = Number(m.ctx.midPx ?? m.ctx.markPx);
      if (mid) latest[m.name] = mid;
    }
    savePaper({ ...paperRef.current, mids: { ...latest, ...paperRef.current.mids, ...latest } });
    let pending = false;
    const flush = () => {
      pending = false;
      const next = paperEngine.tick(paperRef.current, latest, coinByName);
      if (next !== paperRef.current) savePaper(next);
    };
    const unsubs = dexes.map((dex) =>
      hlSocket.subscribe(dex ? { type: 'allMids', dex } : { type: 'allMids' }, (d: { mids: Record<string, string> }) => {
        for (const [k, v] of Object.entries(d.mids)) latest[k] = Number(v);
        if (!pending) {
          pending = true;
          window.setTimeout(flush, 250);
        }
      }),
    );
    // TWAP slices need time to pass even when prices are quiet.
    const t = window.setInterval(flush, 5000);
    return () => {
      unsubs.forEach((u) => u());
      window.clearInterval(t);
    };
  }, [paper, dexKey, savePaper, coinByName]);

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

  const placeOrders = useCallback(
    async (orders: OrderWire[], grouping: Grouping = 'na'): Promise<OrderResult[]> => {
      if (paper) {
        const { state, results } = paperEngine.place(paperRef.current, orders, grouping, coinByAsset);
        savePaper(state);
        setRevision((r) => r + 1);
        return results;
      }
      if (!agentExchange) return orders.map(() => ({ kind: 'error', message: 'Enable trading first.' }));
      try {
        const res = await agentExchange.order(
          {
            orders: orders as never,
            grouping,
            ...(BUILDER_ADDRESS ? { builder: { b: BUILDER_ADDRESS as `0x${string}`, f: BUILDER_FEE_TENTHS_BP } } : {}),
          },
          vaultOpts,
        );
        return statusesOf(res);
      } catch (e) {
        return orders.map(() => ({ kind: 'error', message: errorText(e) }));
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange, paper, savePaper, coinByAsset, vaultOpts],
  );

  const placeOrder = useCallback(async (order: OrderWire) => (await placeOrders([order]))[0], [placeOrders]);

  const cancelOrders = useCallback(
    async (cancels: { a: number; o: number }[]) => {
      if (cancels.length === 0) return;
      if (paper) {
        savePaper(paperEngine.cancel(paperRef.current, cancels.map((c) => c.o)));
        setRevision((r) => r + 1);
        return;
      }
      if (!agentExchange) throw new Error('Enable trading first.');
      try {
        await agentExchange.cancel({ cancels }, vaultOpts);
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange, paper, savePaper, vaultOpts],
  );

  const cancelOrder = useCallback((asset: number, oid: number) => cancelOrders([{ a: asset, o: oid }]), [cancelOrders]);

  const modifyOrder = useCallback(
    async (oid: number, order: OrderWire): Promise<OrderResult> => {
      if (paper) {
        const trig = 'trigger' in order.t ? Number(order.t.trigger.triggerPx) : undefined;
        savePaper(paperEngine.modify(paperRef.current, oid, Number(order.p), trig));
        setRevision((r) => r + 1);
        return { kind: 'resting', oid };
      }
      if (!agentExchange) return { kind: 'error', message: 'Enable trading first.' };
      try {
        await agentExchange.modify({ oid, order: order as never }, vaultOpts);
        return { kind: 'resting', oid };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange, paper, savePaper, vaultOpts],
  );

  const twapOrder = useCallback(
    async (t: TwapInput): Promise<TwapResult> => {
      if (paper) {
        const { state, result } = paperEngine.startTwap(paperRef.current, t, coinByAsset);
        savePaper(state);
        setRevision((r) => r + 1);
        return result;
      }
      if (!agentExchange) return { kind: 'error', message: 'Enable trading first.' };
      try {
        const res = await agentExchange.twapOrder({ twap: t }, vaultOpts);
        const st = res.response.data.status as Record<string, any>;
        return 'running' in st ? { kind: 'running', twapId: st.running.twapId } : { kind: 'error', message: st.error ?? 'TWAP was not accepted.' };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange, paper, savePaper, coinByAsset, vaultOpts],
  );

  const twapCancel = useCallback(
    async (asset: number, twapId: number) => {
      if (paper) {
        savePaper(paperEngine.stopTwap(paperRef.current, twapId));
        setRevision((r) => r + 1);
        return;
      }
      if (!agentExchange) throw new Error('Enable trading first.');
      try {
        await agentExchange.twapCancel({ a: asset, t: twapId }, vaultOpts);
      } finally {
        setRevision((r) => r + 1);
      }
    },
    [agentExchange, paper, savePaper, vaultOpts],
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
    tradingReady: paper || (!!address && agentReady && builderReady && !!agentKey),
    connect: (w) => connect(w),
    disconnect,
    enableTrading,
    placeOrder,
    placeOrders,
    cancelOrder,
    cancelOrders,
    modifyOrder,
    twapOrder,
    twapCancel,
    accounts,
    tradeAccount,
    setTradeAccount,
    paper,
    setPaper,
    paperState,
    resetPaper,
    signMessage,
    revision,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
