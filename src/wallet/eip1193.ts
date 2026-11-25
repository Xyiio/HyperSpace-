// Browser wallet discovery: EIP-6963 announcements (MetaMask, Rabby, Coinbase, ...) with window.ethereum as fallback.
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...args: any[]) => void): void;
  removeListener?(event: string, cb: (...args: any[]) => void): void;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  provider: Eip1193Provider;
}

const found = new Map<string, WalletInfo>();
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', ((e: CustomEvent) => {
    const { info, provider } = e.detail ?? {};
    if (!info?.uuid || !provider) return;
    found.set(info.uuid, { uuid: info.uuid, name: info.name, icon: info.icon, provider });
    listeners.forEach((l) => l());
  }) as EventListener);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function listWallets(): WalletInfo[] {
  const list = [...found.values()];
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (list.length === 0 && injected) list.push({ uuid: 'injected', name: 'Browser wallet', icon: '', provider: injected });
  return list;
}

export function onWalletsChanged(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
