import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';

export interface TokenData {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;        // USD
  lastUpdate: number;       // timestamp
}

export interface TokenSlice {
  tokenDataByPty: Record<string, TokenData>;
  updateTokenData: (ptyId: string, event: Partial<TokenData>) => void;
  clearTokenData: (ptyId: string) => void;
  getTotalCost: () => number;  // all panes combined cost
}

const DEFAULT_TOKEN_DATA: TokenData = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
  lastUpdate: 0,
};

export const createTokenSlice: StateCreator<StoreState, [['zustand/immer', never]], [], TokenSlice> = (set, get) => ({
  tokenDataByPty: {},

  updateTokenData: (ptyId, event) => set((state: StoreState) => {
    if (!state.tokenDataByPty[ptyId]) {
      state.tokenDataByPty[ptyId] = { ...DEFAULT_TOKEN_DATA };
    }
    const data = state.tokenDataByPty[ptyId];
    if (event.totalTokens !== undefined) data.totalTokens = event.totalTokens;
    if (event.inputTokens !== undefined) data.inputTokens = event.inputTokens;
    if (event.outputTokens !== undefined) data.outputTokens = event.outputTokens;
    if (event.totalCost !== undefined) data.totalCost = event.totalCost;
    data.lastUpdate = event.lastUpdate ?? Date.now();
  }),

  clearTokenData: (ptyId) => set((state: StoreState) => {
    delete state.tokenDataByPty[ptyId];
  }),

  getTotalCost: () => {
    const { tokenDataByPty } = get();
    return Object.values(tokenDataByPty).reduce((sum, d) => sum + d.totalCost, 0);
  },
});
