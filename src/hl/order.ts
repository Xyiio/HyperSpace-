// Builds Hyperliquid order actions with a builder code attached.
// Signing is phase 1: the action below is exactly what an approved agent key will sign.
// Wire format mirrors hyperliquid-python-sdk (utils/signing.py: order_request_to_order_wire).

// Builder address that earns fees. Set VITE_BUILDER_ADDRESS at build time.
export const BUILDER_ADDRESS = (import.meta.env.VITE_BUILDER_ADDRESS as string | undefined)?.toLowerCase() ?? null;

// Fee in tenths of a basis point: 10 = 1 bp = 0.01%. Hyperliquid caps perps at 100 (0.1%).
export const BUILDER_FEE_TENTHS_BP = Number(import.meta.env.VITE_BUILDER_FEE ?? 10);

export type Tif = 'Gtc' | 'Ioc' | 'Alo';

export interface OrderInput {
  asset: number;
  isBuy: boolean;
  px: number;
  sz: number;
  pxDecimals: number;
  szDecimals: number;
  reduceOnly: boolean;
  tif: Tif;
}

// Hyperliquid rejects trailing zeros in price and size strings.
export function floatToWire(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function buildOrderAction(o: OrderInput) {
  const action: Record<string, unknown> = {
    type: 'order',
    orders: [
      {
        a: o.asset,
        b: o.isBuy,
        p: floatToWire(o.px, o.pxDecimals),
        s: floatToWire(o.sz, o.szDecimals),
        r: o.reduceOnly,
        t: { limit: { tif: o.tif } },
      },
    ],
    grouping: 'na',
  };
  if (BUILDER_ADDRESS) action.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS_BP };
  return action;
}

/** Builder fee in USD for a given notional. */
export const builderFeeUsd = (notional: number) => (notional * BUILDER_FEE_TENTHS_BP) / 100_000;
