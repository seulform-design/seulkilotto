import React, { createContext, useContext, useEffect, useState } from 'react';

import { api, AppMeta } from '../api/client';

const defaultMeta: AppMeta = {
  ok: false,
  source: 'unknown',
  current_round: 1227,
  latest_round: 1226,
  next_round: 1227,
  row_count: 0,
  gap_count: 0,
  is_complete: false,
};

const AppMetaContext = createContext<AppMeta>(defaultMeta);

export function AppMetaProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<AppMeta>(defaultMeta);

  useEffect(() => {
    api.getMeta().then(setMeta).catch(() => setMeta(defaultMeta));
  }, []);

  return <AppMetaContext.Provider value={meta}>{children}</AppMetaContext.Provider>;
}

export function useAppMeta() {
  return useContext(AppMetaContext);
}
